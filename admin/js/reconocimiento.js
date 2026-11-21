"use strict";

/**
 * Material de reconocimiento: actores (alias y cara), el actor de cada video y su miniatura. Todo pasa por la
 * Edge Function "admin-reconocimiento" (solo administrador): el panel nunca escribe directo en Storage ni en
 * la tabla actores. Cada actor está en un solo video (índice único en la base). Antes de subir, la cara se
 * recorta en el navegador a 360 × 480 px (3:4) y la miniatura se reduce a 480 px en su lado mayor; ambas se
 * convierten a JPEG (calidad 0.8). Todo texto se pinta con textContent.
 */

/** Llamadas a "admin-reconocimiento" con mensajes claros para el administrador (sin datos internos). */
class ClienteReconocimiento {
  static FUNCION = "admin-reconocimiento";
  static MENSAJES = Object.freeze({
    alias_invalido: "El alias debe tener de 1 a 30 caracteres y no puede llevar < > \" &.",
    alias_repetido: "Ya existe un actor con ese alias.",
    imagen_invalida: "El servidor rechazó la imagen: debe ser JPEG, PNG o WebP y pesar como máximo 400 KB.",
    actor_con_videos: "No se puede borrar: el actor está asignado a un video. Quítaselo primero en \"Administrar videos\".",
    no_encontrado: "El actor o el video ya no existe. Recarga la lista.",
    cambio_simultaneo: "Se guardó otro cambio al mismo tiempo. Recarga e intenta de nuevo.",
    actor_ya_asignado: "Ese actor ya está asignado a otro video.",
  });

  #cliente;

  constructor(clienteSupabase) {
    this.#cliente = clienteSupabase;
  }

  async #invocar(accion, datos = {}) {
    let respuesta;
    try {
      respuesta = await this.#cliente.functions.invoke(ClienteReconocimiento.FUNCION, { body: { accion, ...datos } });
    } catch {
      throw new ErrorPanel("No hay conexión con el servidor.");
    }
    const { data, error } = respuesta;
    if (error) {
      const estado = error.context?.status;
      if (estado === 401) throw new ErrorPanel("El servidor no reconoce tu sesión de administrador. Vuelve a iniciar sesión.");
      const cuerpo = await error.context?.json?.().catch(() => null);
      throw new ErrorPanel(ClienteReconocimiento.MENSAJES[cuerpo?.error] ?? "El servidor no pudo completar la operación.");
    }
    return data;
  }

  /** [{ id, alias, cara_url, numero_video }]; numero_video es el del video asignado, o null. */
  async listarActores() {
    const datos = await this.#invocar("listar_actores");
    if (!Array.isArray(datos?.actores)) throw new ErrorPanel("No se pudo leer la lista de actores.");
    return datos.actores;
  }

  /** Map(video_id → URL firmada de la miniatura) */
  async listarMiniaturas() {
    const datos = await this.#invocar("listar_miniaturas");
    if (!Array.isArray(datos?.miniaturas)) throw new ErrorPanel("No se pudieron leer las miniaturas.");
    return new Map(datos.miniaturas.map((m) => [m.video_id, m.miniatura_url]));
  }

  crearActor(alias, imagen) { return this.#invocar("crear_actor", { alias, imagen }); }

  cambiarCara(actorId, imagen) { return this.#invocar("cambiar_cara", { actor_id: actorId, imagen }); }

  borrarActor(actorId) { return this.#invocar("borrar_actor", { actor_id: actorId }); }

  /** Devuelve la ruta nueva de la miniatura. */
  async subirMiniatura(videoId, imagen) {
    const datos = await this.#invocar("subir_miniatura", { video_id: videoId, imagen });
    return typeof datos?.miniatura_ruta === "string" ? datos.miniatura_ruta : null;
  }

  asignarActor(videoId, actorId) { return this.#invocar("asignar_actor", { video_id: videoId, actor_id: actorId }); }
}

/**
 * Convierte un lienzo a JPEG con calidad 0.8. Devuelve el base64 (sin prefijo) y una URL local (blob:) para la
 * vista previa, que hay que liberar con liberar().
 */
class CodificadorJpeg {
  static CALIDAD = 0.8;

  static async codificar(lienzo) {
    const blob = await new Promise((resolver) => lienzo.toBlob(resolver, "image/jpeg", CodificadorJpeg.CALIDAD));
    if (!blob) throw new ErrorPanel("No se pudo convertir la imagen.");
    return { base64: await CodificadorJpeg.#base64(blob), vista: URL.createObjectURL(blob) };
  }

  /** Abre la imagen ya validada (tipo declarado y bytes iniciales: jpeg, png o webp). */
  static async abrir(archivo) {
    await ValidadorVideo.validarImagen(archivo);
    try {
      return await createImageBitmap(archivo);
    } catch {
      throw new ErrorPanel("No se pudo leer la imagen.");
    }
  }

  static liberar(vista) {
    if (vista?.startsWith("blob:")) URL.revokeObjectURL(vista);
  }

  static async #base64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binario = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binario);
  }
}

/** Miniaturas de video: reducidas a 480 px en su lado mayor y convertidas a JPEG. */
class PreparadorDeImagen {
  static LADO_MAXIMO = 480;

  async preparar(archivo) {
    const mapa = await CodificadorJpeg.abrir(archivo);
    try {
      const escala = Math.min(1, PreparadorDeImagen.LADO_MAXIMO / Math.max(mapa.width, mapa.height));
      const lienzo = document.createElement("canvas");
      lienzo.width = Math.max(1, Math.round(mapa.width * escala));
      lienzo.height = Math.max(1, Math.round(mapa.height * escala));
      const ctx = lienzo.getContext("2d");
      ctx.fillStyle = "#fff"; // JPEG no tiene transparencia
      ctx.fillRect(0, 0, lienzo.width, lienzo.height);
      ctx.drawImage(mapa, 0, 0, lienzo.width, lienzo.height);
      return await CodificadorJpeg.codificar(lienzo);
    } finally {
      mapa.close();
    }
  }

  liberar(vista) { CodificadorJpeg.liberar(vista); }
}

/**
 * Ventana de recorte de la cara: marco fijo 3:4 en el que el administrador arrastra la imagen (ratón, dedo o
 * flechas) y ajusta el zoom con el deslizador o con + y −. El zoom mínimo hace que la imagen cubra el marco y
 * el máximo es 4×; la imagen nunca deja huecos dentro del marco. El lienzo de la vista tiene la misma
 * resolución que el recorte final (360 × 480), así lo que se ve es exactamente lo que se sube.
 */
class RecortadorDeCara {
  static ANCHO = 360;
  static ALTO = 480;
  static ZOOM_MAXIMO = 4;
  static PASO_TECLA = 10;  // px del recorte por pulsación (Mayús: ×4)
  static PASO_ZOOM = 0.1;

  #dialogo;
  #lienzo;
  #zoom;
  #valorZoom;
  #mapa = null;
  #escalaMinima = 1;
  #factor = 1;  // zoom actual, de 1 a ZOOM_MAXIMO
  #x = 0;       // esquina superior izquierda de la imagen, en px del recorte
  #y = 0;
  #arrastre = null;

  constructor(dialogo) {
    this.#dialogo = dialogo;
    this.#lienzo = dialogo.querySelector("[data-recorte-lienzo]");
    this.#zoom = dialogo.querySelector("[data-recorte-zoom]");
    this.#valorZoom = dialogo.querySelector("[data-recorte-zoom-valor]");
    this.#lienzo.width = RecortadorDeCara.ANCHO;
    this.#lienzo.height = RecortadorDeCara.ALTO;
    this.#zoom.min = "1";
    this.#zoom.max = String(RecortadorDeCara.ZOOM_MAXIMO);
    this.#zoom.step = "0.01";
    this.#zoom.addEventListener("input", () => this.#ponerZoom(Number(this.#zoom.value)));
    this.#lienzo.addEventListener("pointerdown", (e) => this.#empezarArrastre(e));
    this.#lienzo.addEventListener("pointermove", (e) => this.#arrastrar(e));
    this.#lienzo.addEventListener("pointerup", (e) => this.#terminarArrastre(e));
    this.#lienzo.addEventListener("pointercancel", (e) => this.#terminarArrastre(e));
    this.#lienzo.addEventListener("keydown", (e) => this.#tecla(e));
    this.#lienzo.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.#ponerZoom(this.#factor * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
    }, { passive: false });
  }

  /** Abre la ventana con la imagen. Resuelve con { base64, vista } del recorte, o null si se cancela. */
  async recortar(archivo) {
    const mapa = await CodificadorJpeg.abrir(archivo);
    this.#mapa = mapa;
    this.#escalaMinima = Math.max(RecortadorDeCara.ANCHO / mapa.width, RecortadorDeCara.ALTO / mapa.height);
    this.#factor = 1;
    this.#x = (RecortadorDeCara.ANCHO - mapa.width * this.#escalaMinima) / 2;
    this.#y = (RecortadorDeCara.ALTO - mapa.height * this.#escalaMinima) / 2;
    this.#pintar();
    try {
      const valor = await new Promise((resolver) => {
        this.#dialogo.returnValue = "";
        this.#dialogo.addEventListener("close", () => resolver(this.#dialogo.returnValue), { once: true });
        this.#dialogo.showModal();
        this.#lienzo.focus();
      });
      return valor === "usar" ? await CodificadorJpeg.codificar(this.#lienzo) : null;
    } finally {
      this.#arrastre = null;
      this.#mapa = null;
      mapa.close();
    }
  }

  liberar(vista) { CodificadorJpeg.liberar(vista); }

  #escala() { return this.#escalaMinima * this.#factor; }

  /** Cambia el zoom dejando fijo el punto de la imagen que está en el centro del marco. */
  #ponerZoom(factor) {
    if (!this.#mapa || !Number.isFinite(factor)) return;
    const nuevo = Math.min(RecortadorDeCara.ZOOM_MAXIMO, Math.max(1, factor));
    const cx = RecortadorDeCara.ANCHO / 2;
    const cy = RecortadorDeCara.ALTO / 2;
    const antes = this.#escala();
    this.#factor = nuevo;
    const despues = this.#escala();
    this.#x = cx - ((cx - this.#x) / antes) * despues;
    this.#y = cy - ((cy - this.#y) / antes) * despues;
    this.#pintar();
  }

  #mover(dx, dy) {
    this.#x += dx;
    this.#y += dy;
    this.#pintar();
  }

  /** Mantiene la imagen cubriendo el marco y dibuja el recorte. */
  #pintar() {
    if (!this.#mapa) return;
    const escala = this.#escala();
    const ancho = this.#mapa.width * escala;
    const alto = this.#mapa.height * escala;
    this.#x = Math.min(0, Math.max(RecortadorDeCara.ANCHO - ancho, this.#x));
    this.#y = Math.min(0, Math.max(RecortadorDeCara.ALTO - alto, this.#y));
    const ctx = this.#lienzo.getContext("2d");
    ctx.fillStyle = "#fff"; // JPEG no tiene transparencia
    ctx.fillRect(0, 0, RecortadorDeCara.ANCHO, RecortadorDeCara.ALTO);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(this.#mapa, this.#x, this.#y, ancho, alto);
    this.#zoom.value = String(this.#factor);
    const texto = `${this.#factor.toLocaleString("es-MX", { maximumFractionDigits: 1 })}×`;
    this.#zoom.setAttribute("aria-valuetext", texto);
    this.#valorZoom.textContent = texto;
  }

  /** Px de pantalla → px del recorte (el lienzo se muestra escalado por CSS). */
  #proporcion() {
    const ancho = this.#lienzo.getBoundingClientRect().width;
    return ancho > 0 ? RecortadorDeCara.ANCHO / ancho : 1;
  }

  #empezarArrastre(e) {
    if (e.button !== 0) return;
    this.#arrastre = { id: e.pointerId, x: e.clientX, y: e.clientY, proporcion: this.#proporcion() };
    this.#lienzo.setPointerCapture(e.pointerId);
    this.#lienzo.focus();
  }

  #arrastrar(e) {
    const a = this.#arrastre;
    if (!a || a.id !== e.pointerId) return;
    this.#mover((e.clientX - a.x) * a.proporcion, (e.clientY - a.y) * a.proporcion);
    a.x = e.clientX;
    a.y = e.clientY;
  }

  #terminarArrastre(e) {
    if (this.#arrastre?.id !== e.pointerId) return;
    this.#arrastre = null;
    if (this.#lienzo.hasPointerCapture(e.pointerId)) this.#lienzo.releasePointerCapture(e.pointerId);
  }

  #tecla(e) {
    const paso = RecortadorDeCara.PASO_TECLA * (e.shiftKey ? 4 : 1);
    // Las flechas mueven la imagen: → la desplaza a la derecha, igual que arrastrarla.
    const movimientos = { ArrowLeft: [-paso, 0], ArrowRight: [paso, 0], ArrowUp: [0, -paso], ArrowDown: [0, paso] };
    if (movimientos[e.key]) {
      this.#mover(...movimientos[e.key]);
    } else if (e.key === "+" || e.key === "=" || e.key === "Add") {
      this.#ponerZoom(this.#factor + RecortadorDeCara.PASO_ZOOM);
    } else if (e.key === "-" || e.key === "_" || e.key === "Subtract" || e.key === "−") {
      this.#ponerZoom(this.#factor - RecortadorDeCara.PASO_ZOOM);
    } else {
      return;
    }
    e.preventDefault();
  }
}

/**
 * Controles de reconocimiento de cada fila de "Administrar videos": número permanente ("N.º 7"), selector de
 * actor, subida de miniatura con vista previa y la advertencia "Falta actor o miniatura" en los publicados.
 */
class ControlesDeReconocimiento {
  #cliente;
  #preparador;
  #actores = [];
  #miniaturas = new Map();
  #vistasLocales = new Set();
  #selectores = new Map(); // video_id → { selector, actual } de las filas pintadas
  #alCambiarAsignaciones = () => {};

  constructor(cliente, preparador) {
    this.#cliente = cliente;
    this.#preparador = preparador;
  }

  /** Avisa cuando cambia la asignación de actores (para actualizar la pestaña Actores). */
  alCambiarAsignaciones(callback) { this.#alCambiarAsignaciones = callback; }

  async cargar() {
    for (const vista of this.#vistasLocales) this.#preparador.liberar(vista);
    this.#vistasLocales.clear();
    this.#selectores.clear();
    const [actores, miniaturas] = await Promise.all([this.#cliente.listarActores(), this.#cliente.listarMiniaturas()]);
    this.#actores = actores;
    this.#miniaturas = miniaturas;
  }

  /** alActualizar(cambios): guarda en la lista del panel los cambios ya confirmados por el servidor. */
  conectar(fila, video, alActualizar) {
    const numero = fila.querySelector("[data-numero]");
    numero.textContent = Number.isInteger(video.numero_video) ? `N.º ${video.numero_video}` : "N.º —";
    const selector = fila.querySelector("[data-actor]");
    const archivo = fila.querySelector("[data-miniatura-archivo]");
    const previa = fila.querySelector("[data-miniatura-previa]");
    const vacia = fila.querySelector("[data-miniatura-vacia]");
    const advertencia = fila.querySelector("[data-advertencia]");
    const estado = fila.querySelector("[data-estado-rec]");
    const etiqueta = `«${video.titulo}»`;
    selector.setAttribute("aria-label", `Actor de ${etiqueta}`);
    archivo.setAttribute("aria-label", `Subir miniatura de ${etiqueta}`);

    const actual = { actor_id: video.actor_id ?? null, miniatura_ruta: video.miniatura_ruta ?? null };
    const pintarAdvertencia = () => {
      advertencia.hidden = !(video.publicado && (!actual.actor_id || !actual.miniatura_ruta));
    };
    const ponerVista = (url) => {
      previa.hidden = !url;
      vacia.hidden = Boolean(url);
      if (url) previa.src = url; else previa.removeAttribute("src");
    };

    this.#selectores.set(video.id, { selector, actual });
    this.#pintarOpciones(video.id);
    previa.alt = `Miniatura de ${etiqueta}`;
    ponerVista(this.#miniaturas.get(video.id) ?? null);
    pintarAdvertencia();

    selector.addEventListener("change", async () => {
      const elegido = selector.value || null;
      selector.disabled = true;
      PanelFormato.mensaje(estado, "Guardando actor…");
      try {
        await this.#cliente.asignarActor(video.id, elegido);
        actual.actor_id = elegido;
        alActualizar({ actor_id: elegido });
        PanelFormato.mensaje(estado, elegido ? "Actor guardado." : "Se quitó el actor.", "exito");
        this.#alCambiarAsignaciones();
      } catch (e) {
        PanelFormato.mensaje(estado, PanelFormato.errorVisible(e, "No se pudo guardar el actor."), "error");
      } finally {
        selector.disabled = false;
        this.#pintarTodasLasOpciones();
        pintarAdvertencia();
      }
    });

    archivo.addEventListener("change", async () => {
      const elegido = archivo.files?.[0];
      archivo.value = "";
      if (!elegido) return;
      const anterior = previa.hidden ? null : previa.src;
      archivo.disabled = true;
      PanelFormato.mensaje(estado, "Subiendo miniatura…");
      let vista = null;
      try {
        const preparada = await this.#preparador.preparar(elegido);
        vista = preparada.vista;
        this.#vistasLocales.add(vista);
        ponerVista(vista);
        const ruta = await this.#cliente.subirMiniatura(video.id, preparada.base64);
        actual.miniatura_ruta = ruta ?? "subida";
        alActualizar({ miniatura_ruta: actual.miniatura_ruta });
        PanelFormato.mensaje(estado, "Miniatura guardada.", "exito");
      } catch (e) {
        ponerVista(anterior);
        if (vista) { this.#vistasLocales.delete(vista); this.#preparador.liberar(vista); }
        PanelFormato.mensaje(estado, PanelFormato.errorVisible(e, "No se pudo subir la miniatura."), "error");
      } finally {
        archivo.disabled = false;
        pintarAdvertencia();
      }
    });
  }

  /** Actores ocupados por otros videos (según las filas pintadas, que son todos los videos). */
  #ocupadosPorOtros(videoId) {
    const ocupados = new Set();
    for (const [id, { selector, actual }] of this.#selectores) {
      if (!selector.isConnected) { this.#selectores.delete(id); continue; } // fila ya no pintada (video borrado)
      if (id !== videoId && actual.actor_id) ocupados.add(actual.actor_id);
    }
    return ocupados;
  }

  /** "Sin actor", los actores sin video y el actor que ya tiene este video. */
  #pintarOpciones(videoId) {
    const { selector, actual } = this.#selectores.get(videoId);
    const ocupados = this.#ocupadosPorOtros(videoId);
    const libres = this.#actores.filter((a) => a.id === actual.actor_id || !ocupados.has(a.id));
    selector.replaceChildren(new Option("Sin actor", ""), ...libres.map((a) => new Option(a.alias, a.id)));
    if (actual.actor_id && !this.#actores.some((a) => a.id === actual.actor_id)) selector.append(new Option("Actor desconocido", actual.actor_id));
    selector.value = actual.actor_id ?? "";
  }

  #pintarTodasLasOpciones() {
    for (const id of [...this.#selectores.keys()]) {
      if (this.#selectores.get(id)?.selector.isConnected) this.#pintarOpciones(id);
      else this.#selectores.delete(id);
    }
  }
}

/** Pestaña "Actores": lista con cara, alias y video asignado; crear, cambiar la cara (recortada) y borrar. */
class PestanaActores {
  #cliente;
  #recortador;
  #dialogos;
  #desactualizada = true;
  #ocupado = false;
  #nueva = null; // { base64, vista } de la cara del actor nuevo
  #alCambiarActores = () => {};

  #lista = document.getElementById("actores-lista");
  #conteo = document.getElementById("actores-conteo");
  #vacio = document.getElementById("actores-vacio");
  #mensaje = document.getElementById("actores-mensaje");
  #recargar = document.getElementById("actores-recargar");
  #alias = document.getElementById("actor-alias");
  #contador = document.getElementById("actor-alias-contador");
  #archivo = document.getElementById("actor-cara");
  #vista = document.getElementById("actor-cara-vista");
  #crear = document.getElementById("actor-crear");
  #mensajeForm = document.getElementById("actor-mensaje");

  /** recortador: RecortadorDeCara (toda cara se sube recortada a 3:4). */
  constructor(cliente, recortador, dialogos) {
    this.#cliente = cliente;
    this.#recortador = recortador;
    this.#dialogos = dialogos;
  }

  /** Avisa cuando se crea o borra un actor (cambian las opciones de "Administrar videos"). */
  alCambiarActores(callback) { this.#alCambiarActores = callback; }

  marcarDesactualizada() { this.#desactualizada = true; }

  iniciar() {
    this.#recargar.addEventListener("click", () => this.#cargar());
    this.#alias.addEventListener("input", () => this.#actualizarFormulario());
    this.#archivo.addEventListener("change", () => this.#elegirCara());
    this.#crear.addEventListener("click", () => this.#crearActor());
    this.#actualizarFormulario();
  }

  async mostrar() {
    if (this.#desactualizada) await this.#cargar();
  }

  async #cargar() {
    PanelFormato.mensaje(this.#mensaje, "Cargando actores…");
    this.#recargar.disabled = true;
    try {
      const actores = await this.#cliente.listarActores();
      this.#desactualizada = false;
      this.#lista.replaceChildren(...actores.map((a) => this.#fila(a)));
      this.#vacio.hidden = actores.length > 0;
      this.#conteo.textContent = actores.length === 1 ? "1 actor" : `${actores.length} actores`;
      PanelFormato.mensaje(this.#mensaje, "");
    } catch (e) {
      PanelFormato.mensaje(this.#mensaje, PanelFormato.errorVisible(e, "No se pudo cargar la lista de actores."), "error");
    } finally {
      this.#recargar.disabled = false;
    }
  }

  #fila(actor) {
    const fila = document.getElementById("tpl-actor").content.firstElementChild.cloneNode(true);
    const cara = fila.querySelector("[data-cara]");
    cara.src = actor.cara_url;
    cara.alt = `Cara de ${actor.alias}`;
    fila.querySelector("[data-alias]").textContent = actor.alias;
    const asignado = actor.numero_video !== null && actor.numero_video !== undefined;
    fila.querySelector("[data-asignacion]").textContent = asignado ? `Asignado al video N.º ${actor.numero_video}` : "Sin asignar";
    const cambiar = fila.querySelector("[data-cambiar-cara]");
    cambiar.setAttribute("aria-label", `Cambiar la cara de ${actor.alias}`);
    cambiar.addEventListener("change", () => this.#cambiarCara(actor, cambiar, cara));
    const borrar = fila.querySelector("[data-borrar-actor]");
    borrar.disabled = asignado;
    borrar.setAttribute("aria-label", `Borrar a ${actor.alias}`);
    borrar.title = asignado ? "Está asignado a un video: quítaselo antes de borrarlo." : "";
    borrar.addEventListener("click", () => this.#borrar(actor));
    return fila;
  }

  #actualizarFormulario() {
    const largo = [...this.#alias.value.trim()].length;
    this.#contador.textContent = `${largo}/30`;
    this.#crear.disabled = this.#ocupado || largo < 1 || largo > 30 || !this.#nueva;
  }

  async #elegirCara() {
    const archivo = this.#archivo.files?.[0];
    this.#archivo.value = "";
    if (!archivo) return;
    PanelFormato.mensaje(this.#mensajeForm, "");
    try {
      const preparada = await this.#recortador.recortar(archivo);
      if (!preparada) return; // canceló el recorte: se conserva la cara elegida antes
      this.#recortador.liberar(this.#nueva?.vista);
      this.#nueva = preparada;
      this.#vista.src = preparada.vista;
      this.#vista.hidden = false;
    } catch (e) {
      PanelFormato.mensaje(this.#mensajeForm, PanelFormato.errorVisible(e, "No se pudo leer la imagen."), "error");
    } finally {
      this.#actualizarFormulario();
    }
  }

  async #crearActor() {
    if (this.#ocupado || !this.#nueva) return;
    const alias = this.#alias.value.replace(/\s+/g, " ").trim();
    if (/[<>"&]/.test(alias)) {
      PanelFormato.mensaje(this.#mensajeForm, ClienteReconocimiento.MENSAJES.alias_invalido, "error");
      return;
    }
    this.#bloquear(true);
    PanelFormato.mensaje(this.#mensajeForm, "Creando actor…");
    try {
      await this.#cliente.crearActor(alias, this.#nueva.base64);
      this.#recortador.liberar(this.#nueva.vista);
      this.#nueva = null;
      this.#alias.value = "";
      this.#vista.hidden = true;
      this.#vista.removeAttribute("src");
      PanelFormato.mensaje(this.#mensajeForm, `Se creó a «${alias}».`, "exito");
      this.#alCambiarActores();
      await this.#cargar();
    } catch (e) {
      PanelFormato.mensaje(this.#mensajeForm, PanelFormato.errorVisible(e, "No se pudo crear el actor."), "error");
    } finally {
      this.#bloquear(false);
    }
  }

  async #cambiarCara(actor, entrada, cara) {
    const archivo = entrada.files?.[0];
    entrada.value = "";
    if (!archivo || this.#ocupado) return;
    this.#ocupado = true;
    entrada.disabled = true;
    const anterior = cara.src;
    let vista = null;
    try {
      const preparada = await this.#recortador.recortar(archivo);
      if (!preparada) return; // canceló el recorte
      PanelFormato.mensaje(this.#mensaje, `Cambiando la cara de «${actor.alias}»…`);
      vista = preparada.vista;
      cara.src = vista;
      await this.#cliente.cambiarCara(actor.id, preparada.base64);
      PanelFormato.mensaje(this.#mensaje, `Se cambió la cara de «${actor.alias}».`, "exito");
    } catch (e) {
      cara.src = anterior;
      this.#recortador.liberar(vista);
      PanelFormato.mensaje(this.#mensaje, PanelFormato.errorVisible(e, "No se pudo cambiar la cara."), "error");
    } finally {
      this.#ocupado = false;
      entrada.disabled = false;
    }
  }

  async #borrar(actor) {
    if (this.#ocupado) return;
    if (!(await this.#dialogos.confirmar(`¿Borrar a «${actor.alias}» y su cara? No se puede deshacer.`, "Borrar actor"))) return;
    this.#ocupado = true;
    PanelFormato.mensaje(this.#mensaje, "Borrando…");
    try {
      await this.#cliente.borrarActor(actor.id);
      PanelFormato.mensaje(this.#mensaje, `Se borró a «${actor.alias}».`, "exito");
      this.#alCambiarActores();
      await this.#cargar();
      PanelFormato.mensaje(this.#mensaje, `Se borró a «${actor.alias}».`, "exito");
    } catch (e) {
      PanelFormato.mensaje(this.#mensaje, PanelFormato.errorVisible(e, "No se pudo borrar el actor."), "error");
    } finally {
      this.#ocupado = false;
    }
  }

  #bloquear(si) {
    this.#ocupado = si;
    this.#alias.disabled = si;
    this.#archivo.disabled = si;
    this.#actualizarFormulario();
  }
}
