"use strict";

/**
 * Material de reconocimiento: actores (alias y cara), el actor de cada video y su miniatura. Todo pasa por la
 * Edge Function "admin-reconocimiento" (solo administrador): el panel nunca escribe directo en Storage ni en
 * la tabla actores. Antes de subir, cada imagen se reduce en el navegador a 480 px en su lado mayor y se
 * convierte a JPEG (calidad 0.8). Todo texto se pinta con textContent.
 */

/** Llamadas a "admin-reconocimiento" con mensajes claros para el administrador (sin datos internos). */
class ClienteReconocimiento {
  static FUNCION = "admin-reconocimiento";
  static MENSAJES = Object.freeze({
    alias_invalido: "El alias debe tener de 1 a 30 caracteres y no puede llevar < > \" &.",
    alias_repetido: "Ya existe un actor con ese alias.",
    imagen_invalida: "El servidor rechazó la imagen: debe ser JPEG, PNG o WebP y pesar como máximo 400 KB.",
    actor_con_videos: "No se puede borrar: el actor tiene videos asignados. Quítaselos primero en \"Administrar videos\".",
    no_encontrado: "El actor o el video ya no existe. Recarga la lista.",
    cambio_simultaneo: "Se guardó otro cambio al mismo tiempo. Recarga e intenta de nuevo.",
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

  /** [{ id, alias, cara_url, videos }] */
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
 * Prepara una imagen para subirla: solo JPEG, PNG o WebP (por tipo y por firma), reducida a 480 px en su lado
 * mayor y convertida a JPEG con calidad 0.8 en un canvas. Devuelve el base64 (sin prefijo) y una URL local
 * (blob:) para la vista previa, que hay que liberar con liberar().
 */
class PreparadorDeImagen {
  static LADO_MAXIMO = 480;
  static CALIDAD = 0.8;

  async preparar(archivo) {
    await ValidadorVideo.validarImagen(archivo); // tipo declarado y bytes iniciales: jpeg, png o webp
    let mapa;
    try {
      mapa = await createImageBitmap(archivo);
    } catch {
      throw new ErrorPanel("No se pudo leer la imagen.");
    }
    try {
      const escala = Math.min(1, PreparadorDeImagen.LADO_MAXIMO / Math.max(mapa.width, mapa.height));
      const lienzo = document.createElement("canvas");
      lienzo.width = Math.max(1, Math.round(mapa.width * escala));
      lienzo.height = Math.max(1, Math.round(mapa.height * escala));
      const ctx = lienzo.getContext("2d");
      ctx.fillStyle = "#fff"; // JPEG no tiene transparencia
      ctx.fillRect(0, 0, lienzo.width, lienzo.height);
      ctx.drawImage(mapa, 0, 0, lienzo.width, lienzo.height);
      const blob = await new Promise((resolver) => lienzo.toBlob(resolver, "image/jpeg", PreparadorDeImagen.CALIDAD));
      if (!blob) throw new ErrorPanel("No se pudo convertir la imagen.");
      return { base64: await PreparadorDeImagen.#base64(blob), vista: URL.createObjectURL(blob) };
    } finally {
      mapa.close();
    }
  }

  liberar(vista) {
    if (vista?.startsWith("blob:")) URL.revokeObjectURL(vista);
  }

  static async #base64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binario = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binario);
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
  #alCambiarAsignaciones = () => {};

  constructor(cliente, preparador) {
    this.#cliente = cliente;
    this.#preparador = preparador;
  }

  /** Avisa cuando cambia la asignación de actores (para recalcular los conteos de la pestaña Actores). */
  alCambiarAsignaciones(callback) { this.#alCambiarAsignaciones = callback; }

  async cargar() {
    for (const vista of this.#vistasLocales) this.#preparador.liberar(vista);
    this.#vistasLocales.clear();
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

    selector.replaceChildren(new Option("Sin actor", ""), ...this.#actores.map((a) => new Option(a.alias, a.id)));
    if (actual.actor_id && !this.#actores.some((a) => a.id === actual.actor_id)) selector.append(new Option("Actor desconocido", actual.actor_id));
    selector.value = actual.actor_id ?? "";
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
        PanelFormato.mensaje(estado, "Actor guardado.", "exito");
        this.#alCambiarAsignaciones();
      } catch (e) {
        selector.value = actual.actor_id ?? "";
        PanelFormato.mensaje(estado, PanelFormato.errorVisible(e, "No se pudo guardar el actor."), "error");
      } finally {
        selector.disabled = false;
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
}

/** Pestaña "Actores": lista con cara, alias y videos asignados; crear, cambiar la cara y borrar. */
class PestanaActores {
  #cliente;
  #preparador;
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

  constructor(cliente, preparador, dialogos) {
    this.#cliente = cliente;
    this.#preparador = preparador;
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
    const videos = Number(actor.videos) || 0;
    fila.querySelector("[data-videos]").textContent = videos === 1 ? "1 video asignado" : `${videos} videos asignados`;
    const cambiar = fila.querySelector("[data-cambiar-cara]");
    cambiar.setAttribute("aria-label", `Cambiar la cara de ${actor.alias}`);
    cambiar.addEventListener("change", () => this.#cambiarCara(actor, cambiar, cara));
    const borrar = fila.querySelector("[data-borrar-actor]");
    borrar.disabled = videos > 0;
    borrar.setAttribute("aria-label", `Borrar a ${actor.alias}`);
    borrar.title = videos > 0 ? "Tiene videos asignados: quítaselos antes de borrarlo." : "";
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
      const preparada = await this.#preparador.preparar(archivo);
      this.#preparador.liberar(this.#nueva?.vista);
      this.#nueva = preparada;
      this.#vista.src = preparada.vista;
      this.#vista.hidden = false;
    } catch (e) {
      PanelFormato.mensaje(this.#mensajeForm, PanelFormato.errorVisible(e, "No se pudo leer la imagen."), "error");
    }
    this.#actualizarFormulario();
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
      this.#preparador.liberar(this.#nueva.vista);
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
    PanelFormato.mensaje(this.#mensaje, `Cambiando la cara de «${actor.alias}»…`);
    let vista = null;
    try {
      const preparada = await this.#preparador.preparar(archivo);
      vista = preparada.vista;
      cara.src = vista;
      await this.#cliente.cambiarCara(actor.id, preparada.base64);
      PanelFormato.mensaje(this.#mensaje, `Se cambió la cara de «${actor.alias}».`, "exito");
    } catch (e) {
      cara.src = anterior;
      this.#preparador.liberar(vista);
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
