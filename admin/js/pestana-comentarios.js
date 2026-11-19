"use strict";

/** Iniciales y color del círculo de un comentario sin foto. */
class AvatarIniciales {
  // Todos con contraste de al menos 4.5:1 contra texto blanco.
  static PALETA = Object.freeze([
    "#C2185B", "#AD1457", "#7B1FA2", "#6A1B9A", "#512DA8", "#303F9F",
    "#1565C0", "#00695C", "#2E7D32", "#BF360C", "#5D4037", "#455A64",
  ]);
  static PATRON_COLOR = /^#[0-9a-f]{6}$/i;

  /** usuario.uno → UU; ana → AN. */
  static iniciales(usuario) {
    const partes = String(usuario ?? "").replace(/^@+/, "").split(/[._]+/).filter(Boolean);
    if (!partes.length) return "?";
    const texto = partes.length >= 2
      ? [...partes[0]][0] + [...partes[1]][0]
      : [...partes[0]].slice(0, 2).join("");
    return texto.toUpperCase();
  }

  static colorAlAzar() {
    const i = crypto.getRandomValues(new Uint32Array(1))[0] % AvatarIniciales.PALETA.length;
    return AvatarIniciales.PALETA[i];
  }

  /** Un color guardado solo se usa si es un hex válido; si no, uno fijo de la paleta. */
  static colorSeguro(color) {
    return AvatarIniciales.PATRON_COLOR.test(color ?? "") ? color : AvatarIniciales.PALETA[AvatarIniciales.PALETA.length - 1];
  }

  /** Foto si existe; si no (o si falla al cargar), círculo con iniciales. */
  static crear(comentario, urlFoto) {
    const caja = document.createElement("div");
    caja.className = "avatar-com";
    const ponerIniciales = () => {
      const span = document.createElement("span");
      span.textContent = AvatarIniciales.iniciales(comentario.usuario);
      caja.style.backgroundColor = AvatarIniciales.colorSeguro(comentario.color);
      caja.replaceChildren(span);
    };
    if (urlFoto) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = urlFoto;
      img.addEventListener("error", ponerIniciales, { once: true });
      caja.append(img);
    } else {
      ponerIniciales();
    }
    return caja;
  }
}

/** Reglas de los comentarios simulados y de los contadores. Reflejan la tabla public.comentarios. */
class ValidadorComentario {
  static MAX_USUARIO = 30;
  static MAX_TEXTO = 150;
  static MAX_CONTADOR = 2147483647; // máximo de un integer en PostgreSQL

  static normalizar(datos) {
    const limpio = (v) => String(v ?? "").replace(/\u0000/g, "").trim();
    return { usuario: limpio(datos.usuario).replace(/^@+/, ""), texto: limpio(datos.texto) };
  }

  static validar({ usuario, texto }) {
    const errores = {};
    const nU = ValidadorVideo.largo(usuario);
    const nT = ValidadorVideo.largo(texto);
    if (nU === 0) errores.usuario = "El @usuario es obligatorio.";
    else if (nU > ValidadorComentario.MAX_USUARIO) errores.usuario = `El @usuario no puede pasar de ${ValidadorComentario.MAX_USUARIO} caracteres (tiene ${nU}).`;
    else if (!ValidadorVideo.PATRON_USUARIO.test(usuario)) errores.usuario = "El @usuario solo puede tener letras sin acentos, números, punto y guion bajo.";
    if (nT === 0) errores.texto = "El comentario no puede estar vacío.";
    else if (nT > ValidadorComentario.MAX_TEXTO) errores.texto = `El comentario no puede pasar de ${ValidadorComentario.MAX_TEXTO} caracteres (tiene ${nT}).`;
    return errores;
  }

  /** Devuelve el entero o lanza ErrorPanel con un mensaje claro. */
  static contador(texto) {
    const t = String(texto ?? "").trim();
    if (!/^\d+$/.test(t)) throw new ErrorPanel("Escribe un número entero de 0 en adelante, sin puntos ni comas.");
    const n = Number(t);
    if (!Number.isSafeInteger(n) || n > ValidadorComentario.MAX_CONTADOR) {
      throw new ErrorPanel(`El número no puede pasar de ${ValidadorComentario.MAX_CONTADOR}.`);
    }
    return n;
  }
}

/** Acceso a public.comentarios y a las fotos de la carpeta comentarios/ del bucket "imagenes". */
class ComentarioRepositorio {
  static COLUMNAS = "id,video_id,usuario,texto,foto_perfil_ruta,color,creado_en";
  static RUTA_FOTO = /^comentarios\/[0-9a-f-]{36}\.(png|jpg|webp)$/;

  #sb;
  #videos;

  constructor(cliente, videoRepo) {
    this.#sb = cliente;
    this.#videos = videoRepo;
  }

  async listar(videoId) {
    const { data, error } = await this.#sb.from("comentarios").select(ComentarioRepositorio.COLUMNAS)
      .eq("video_id", videoId).order("creado_en", { ascending: false });
    if (error) throw this.#traducir(error, "No se pudieron cargar los comentarios.");
    return data ?? [];
  }

  async crear(fila) {
    const { data, error } = await this.#sb.from("comentarios").insert(fila)
      .select(ComentarioRepositorio.COLUMNAS).single();
    if (error) throw this.#traducir(error, "No se pudo guardar el comentario.");
    return data;
  }

  async actualizar(id, cambios) {
    const { data, error } = await this.#sb.from("comentarios").update(cambios).eq("id", id)
      .select(ComentarioRepositorio.COLUMNAS).single();
    if (error) throw this.#traducir(error, "No se pudieron guardar los cambios del comentario.");
    return data;
  }

  /** Borra el comentario y luego su foto si ya nadie la usa. Devuelve false si la foto no se pudo borrar. */
  async borrar(comentario) {
    const { data, error } = await this.#sb.from("comentarios").delete().eq("id", comentario.id).select("id");
    if (error) throw this.#traducir(error, "No se pudo borrar el comentario.");
    if (!data?.length) throw new ErrorPanel("No se pudo borrar el comentario: no existe o no tienes permiso.");
    return comentario.foto_perfil_ruta ? this.borrarFotoSiLibre(comentario.foto_perfil_ruta) : true;
  }

  async subirFoto(archivo) {
    const ext = await ValidadorVideo.validarImagen(archivo);
    const ruta = this.#videos.nuevaRuta("comentarios", ext);
    await this.#videos.subirArchivo("imagenes", ruta, archivo);
    return ruta;
  }

  /** true si quedó borrada o si no se debe borrar (otra fila la usa o no la creó este panel). */
  async borrarFotoSiLibre(ruta) {
    if (!ComentarioRepositorio.RUTA_FOTO.test(ruta)) return true;
    const { data, error } = await this.#sb.from("comentarios").select("id").eq("foto_perfil_ruta", ruta).limit(1);
    if (error || data.length > 0) return true; // ante la duda, no se borra
    return this.#videos.borrarArchivos("imagenes", [ruta]);
  }

  urlFoto(ruta) {
    return this.#videos.urlImagen(ruta);
  }

  #traducir(error, generico) {
    const codigo = error?.code;
    if (codigo === "42501" || codigo === "PGRST301" || error?.status === 401 || error?.status === 403) {
      return new ErrorPanel("La base de datos rechazó la operación: tu sesión no tiene permiso o terminó.");
    }
    if (codigo === "23514" || codigo === "22001" || codigo === "23502") {
      return new ErrorPanel("Algún dato no cumple las reglas de la base de datos (campo obligatorio o largo).");
    }
    if (codigo === "23503") return new ErrorPanel("El video de este comentario ya no existe.");
    if (codigo === "PGRST116") return new ErrorPanel(`${generico} No existe o no tienes permiso.`);
    return new ErrorPanel(generico);
  }
}

/** Un campo numérico con su botón Guardar (Me gusta, Comentarios, Guardados). */
class EditorContador {
  #input;
  #boton;
  #error;
  #mensaje;
  #alGuardar;

  constructor(contenedor, { prefijo, etiqueta, ayuda }, alGuardar) {
    const raiz = document.getElementById("tpl-contador").content.firstElementChild.cloneNode(true);
    this.#input = raiz.querySelector("[data-numero]");
    this.#boton = raiz.querySelector("[data-guardar]");
    this.#error = raiz.querySelector("[data-error]");
    this.#mensaje = raiz.querySelector("[data-mensaje]");
    this.#alGuardar = alGuardar;
    this.#input.id = `${prefijo}-numero`;
    const label = raiz.querySelector("[data-etiqueta]");
    label.htmlFor = this.#input.id;
    label.textContent = etiqueta;
    raiz.querySelector("[data-ayuda]").textContent = ayuda;
    contenedor.replaceChildren(raiz);

    this.#input.addEventListener("input", () => { this.#error.textContent = ""; PanelFormato.mensaje(this.#mensaje, ""); });
    this.#input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this.#guardar(); } });
    this.#boton.addEventListener("click", () => this.#guardar());
  }

  mostrar(valor) {
    this.#input.value = String(Number.isInteger(valor) && valor >= 0 ? valor : 0);
    this.#error.textContent = "";
    PanelFormato.mensaje(this.#mensaje, "");
  }

  async #guardar() {
    let valor;
    try {
      valor = ValidadorComentario.contador(this.#input.value);
    } catch (e) {
      this.#error.textContent = PanelFormato.errorVisible(e, "Número inválido.");
      this.#input.focus();
      return;
    }
    this.#boton.disabled = true;
    this.#input.disabled = true;
    PanelFormato.mensaje(this.#mensaje, "Guardando…");
    try {
      const guardado = await this.#alGuardar(valor);
      this.#input.value = String(guardado);
      PanelFormato.mensaje(this.#mensaje, "Guardado.", "exito");
    } catch (e) {
      PanelFormato.mensaje(this.#mensaje, PanelFormato.errorVisible(e, "No se pudo guardar."), "error");
    } finally {
      this.#boton.disabled = false;
      this.#input.disabled = false;
    }
  }
}

/** Pestaña "Comentarios": lista de videos y, por video, contadores y comentarios simulados. */
class PestanaComentarios {
  static SECCIONES = Object.freeze(["me_gusta", "comentarios", "guardados"]);

  #repo;
  #coms;
  #dialogos;
  #videos = [];
  #video = null;
  #comentarios = [];
  #editando = null;
  #foto = { ruta: null, archivo: null };
  #ocupado = false;
  #turnoLista = 0;
  #turnoComentarios = 0;
  #contadores = {};

  #vistaLista = document.getElementById("com-lista");
  #vistaDetalle = document.getElementById("com-detalle");
  #filas = document.getElementById("com-filas");
  #conteo = document.getElementById("com-conteo");
  #vacio = document.getElementById("com-vacio");
  #mensajeLista = document.getElementById("com-mensaje-lista");
  #botonRecargar = document.getElementById("com-recargar");
  #miniatura = document.getElementById("com-miniatura");
  #form = document.getElementById("com-form");
  #mensajeForm = document.getElementById("com-mensaje-form");
  #mensajeComentarios = document.getElementById("com-mensaje-lista-comentarios");
  #listaComentarios = document.getElementById("com-comentarios");
  #sinComentarios = document.getElementById("com-sin-comentarios");

  constructor(repo, comentariosRepo, dialogos) {
    this.#repo = repo;
    this.#coms = comentariosRepo;
    this.#dialogos = dialogos;
  }

  iniciar() {
    this.#botonRecargar.addEventListener("click", () => this.#cargarLista());
    document.getElementById("com-volver").addEventListener("click", () => this.#volver());
    document.querySelectorAll("[data-seccion-com]").forEach((b) => {
      b.addEventListener("click", () => this.#elegirSeccion(b.dataset.seccionCom));
    });

    const guardarEn = (columna) => async (valor) => {
      const actualizado = await this.#repo.actualizar(this.#video.id, { [columna]: valor });
      this.#reemplazarVideo(actualizado);
      return actualizado[columna];
    };
    this.#contadores = {
      me_gusta_num: new EditorContador(document.getElementById("com-contador-me-gusta"),
        { prefijo: "com-me-gusta", etiqueta: "Número de me gusta", ayuda: "Es el número que verán los participantes en el feed." },
        guardarEn("me_gusta_num")),
      comentarios_num: new EditorContador(document.getElementById("com-contador-comentarios"),
        { prefijo: "com-comentarios", etiqueta: "Número de comentarios", ayuda: "Independiente de cuántos comentarios escribas abajo." },
        guardarEn("comentarios_num")),
      guardados_num: new EditorContador(document.getElementById("com-contador-guardados"),
        { prefijo: "com-guardados", etiqueta: "Número de guardados", ayuda: "Es el número que verán los participantes en el feed." },
        guardarEn("guardados_num")),
    };

    this.#conectarFormulario();
  }

  /** Se llama al entrar a la pestaña: recarga la lista para ver altas, ediciones y publicaciones recientes. */
  async mostrar() {
    if (!this.#video) await this.#cargarLista();
  }

  // ------------------------------------------------------------- lista de videos
  async #cargarLista() {
    const turno = ++this.#turnoLista;
    PanelFormato.mensaje(this.#mensajeLista, "Cargando videos…");
    this.#botonRecargar.disabled = true;
    try {
      const videos = await this.#repo.listar();
      const urls = await this.#repo.urlsVideos(videos.map((v) => v.ruta_archivo)).catch(() => new Map());
      if (turno !== this.#turnoLista) return;
      this.#videos = videos;
      this.#filas.replaceChildren(...videos.map((v) => this.#fila(v, urls.get(v.ruta_archivo))));
      this.#vacio.hidden = videos.length > 0;
      this.#conteo.textContent = videos.length === 1 ? "1 video" : `${videos.length} videos`;
      PanelFormato.mensaje(this.#mensajeLista, "");
    } catch (e) {
      if (turno === this.#turnoLista) {
        PanelFormato.mensaje(this.#mensajeLista, PanelFormato.errorVisible(e, "No se pudo cargar la lista de videos."), "error");
      }
    } finally {
      if (turno === this.#turnoLista) this.#botonRecargar.disabled = false;
    }
  }

  #fila(video, urlFirmada) {
    const fila = document.getElementById("tpl-fila-com").content.firstElementChild.cloneNode(true);
    if (urlFirmada) fila.querySelector("[data-miniatura]").src = `${urlFirmada}#t=0.5`;
    fila.querySelector("[data-titulo]").textContent = video.titulo;
    fila.querySelector("[data-descripcion]").textContent = video.descripcion ?? "Sin descripción";
    fila.querySelector("[data-usuario]").textContent = video.usuario ? `@${video.usuario}` : "—";
    fila.querySelector("[data-fecha]").textContent = PanelFormato.fecha(video.creado_en);
    const estado = fila.querySelector("[data-estado-pub]");
    estado.textContent = video.publicado ? `Publicado · ${PanelFormato.fecha(video.publicado_en)}` : "Sin publicar";
    estado.dataset.publicado = String(Boolean(video.publicado));
    const abrir = fila.querySelector("[data-abrir]");
    abrir.setAttribute("aria-label", `Abrir «${video.titulo}»`);
    abrir.addEventListener("click", () => this.#abrir(video, urlFirmada));
    return fila;
  }

  // ----------------------------------------------------------- detalle del video
  #abrir(video, urlFirmada) {
    this.#video = video;
    document.getElementById("com-titulo").textContent = video.titulo;
    this.#miniatura.removeAttribute("src");
    if (urlFirmada) this.#miniatura.src = `${urlFirmada}#t=0.5`;
    else this.#repo.urlVideo(video.ruta_archivo).then((u) => { if (this.#video?.id === video.id) this.#miniatura.src = `${u}#t=0.5`; }).catch(() => {});

    this.#contadores.me_gusta_num.mostrar(video.me_gusta_num);
    this.#contadores.comentarios_num.mostrar(video.comentarios_num);
    this.#contadores.guardados_num.mostrar(video.guardados_num);
    this.#actualizarNumerosMenu();
    this.#cancelarEdicion();
    this.#comentarios = [];
    this.#listaComentarios.replaceChildren();
    this.#sinComentarios.hidden = true;
    PanelFormato.mensaje(this.#mensajeComentarios, "");

    this.#vistaLista.hidden = true;
    this.#vistaDetalle.hidden = false;
    this.#elegirSeccion("me_gusta");
    this.#cargarComentarios();
  }

  async #volver() {
    if (this.#ocupado) return;
    if (this.#formTieneDatos() && !(await this.#dialogos.confirmar("Hay un comentario sin guardar. ¿Salir sin guardarlo?", "Salir sin guardar"))) return;
    this.#video = null;
    this.#miniatura.removeAttribute("src");
    this.#miniatura.load();
    this.#vistaDetalle.hidden = true;
    this.#vistaLista.hidden = false;
    await this.#cargarLista();
  }

  #elegirSeccion(clave) {
    if (!PestanaComentarios.SECCIONES.includes(clave)) return;
    document.querySelectorAll("[data-seccion-com]").forEach((b) => {
      const activa = b.dataset.seccionCom === clave;
      b.classList.toggle("activa", activa);
      if (activa) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-panel-com]").forEach((s) => { s.hidden = s.dataset.panelCom !== clave; });
  }

  #reemplazarVideo(actualizado) {
    this.#video = actualizado;
    this.#videos = this.#videos.map((v) => (v.id === actualizado.id ? actualizado : v));
    this.#actualizarNumerosMenu();
  }

  #actualizarNumerosMenu() {
    const v = this.#video ?? {};
    for (const [clave, columna] of [["me_gusta", "me_gusta_num"], ["comentarios", "comentarios_num"], ["guardados", "guardados_num"]]) {
      const n = document.querySelector(`[data-seccion-com="${clave}"] [data-num]`);
      n.textContent = Number.isInteger(v[columna]) ? v[columna].toLocaleString("es-MX") : "0";
    }
  }

  // ------------------------------------------------------------------ comentarios
  async #cargarComentarios() {
    const turno = ++this.#turnoComentarios;
    const video = this.#video;
    PanelFormato.mensaje(this.#mensajeComentarios, "Cargando comentarios…");
    try {
      const lista = await this.#coms.listar(video.id);
      if (turno !== this.#turnoComentarios || this.#video?.id !== video.id) return;
      this.#comentarios = lista;
      PanelFormato.mensaje(this.#mensajeComentarios, "");
      this.#pintarComentarios();
    } catch (e) {
      if (turno === this.#turnoComentarios) {
        PanelFormato.mensaje(this.#mensajeComentarios, PanelFormato.errorVisible(e, "No se pudieron cargar los comentarios."), "error");
      }
    }
  }

  #pintarComentarios() {
    this.#listaComentarios.replaceChildren(...this.#comentarios.map((c) => this.#itemComentario(c)));
    this.#sinComentarios.hidden = this.#comentarios.length > 0;
    document.getElementById("com-total-escritos").textContent = this.#comentarios.length === 1
      ? "1 comentario escrito" : `${this.#comentarios.length} comentarios escritos`;
  }

  #itemComentario(c) {
    const item = document.getElementById("tpl-comentario").content.firstElementChild.cloneNode(true);
    item.querySelector("[data-avatar]").replaceWith(AvatarIniciales.crear(c, this.#coms.urlFoto(c.foto_perfil_ruta)));
    item.querySelector("[data-usuario]").textContent = `@${c.usuario}`;
    item.querySelector("[data-fecha]").textContent = PanelFormato.fecha(c.creado_en);
    item.querySelector("[data-texto]").textContent = c.texto;
    const editar = item.querySelector("[data-editar]");
    const borrar = item.querySelector("[data-borrar]");
    editar.setAttribute("aria-label", `Editar comentario de @${c.usuario}`);
    borrar.setAttribute("aria-label", `Borrar comentario de @${c.usuario}`);
    editar.addEventListener("click", () => this.#editar(c));
    borrar.addEventListener("click", () => this.#borrar(c));
    if (this.#editando?.id === c.id) item.classList.add("en-edicion");
    return item;
  }

  #conectarFormulario() {
    const usuario = document.getElementById("com-usuario");
    const texto = document.getElementById("com-texto");
    const contadorTexto = document.getElementById("com-texto-contador");
    const contadorUsuario = document.getElementById("com-usuario-contador");
    const actualizar = () => {
      const nT = ValidadorVideo.largo(texto.value);
      contadorTexto.textContent = `${nT}/${ValidadorComentario.MAX_TEXTO}`;
      contadorTexto.classList.toggle("excedido", nT > ValidadorComentario.MAX_TEXTO);
      const nU = ValidadorVideo.largo(usuario.value.replace(/^@+/, ""));
      contadorUsuario.textContent = `${nU}/${ValidadorComentario.MAX_USUARIO}`;
      contadorUsuario.classList.toggle("excedido", nU > ValidadorComentario.MAX_USUARIO);
    };
    usuario.addEventListener("input", () => { this.#errorCampo("usuario", ""); actualizar(); });
    texto.addEventListener("input", () => { this.#errorCampo("texto", ""); actualizar(); });
    actualizar();

    document.getElementById("com-foto").addEventListener("change", (e) => this.#elegirFoto(e.currentTarget));
    document.getElementById("com-foto-quitar").addEventListener("click", () => {
      this.#foto = { ruta: null, archivo: null };
      this.#pintarFoto();
    });
    document.getElementById("com-cancelar").addEventListener("click", () => this.#cancelarEdicion());
    document.getElementById("com-enviar").addEventListener("click", () => this.#enviar());
  }

  #editar(c) {
    if (this.#ocupado) return;
    this.#editando = c;
    document.getElementById("com-usuario").value = c.usuario;
    document.getElementById("com-texto").value = c.texto;
    document.getElementById("com-texto").dispatchEvent(new Event("input"));
    this.#foto = { ruta: c.foto_perfil_ruta ?? null, archivo: null };
    this.#pintarFoto();
    document.getElementById("com-form-titulo").textContent = `Editar comentario de @${c.usuario}`;
    document.getElementById("com-enviar").textContent = "Guardar cambios";
    document.getElementById("com-cancelar").hidden = false;
    PanelFormato.mensaje(this.#mensajeForm, "");
    this.#pintarComentarios();
    this.#form.scrollIntoView({ behavior: "smooth", block: "start" });
    document.getElementById("com-texto").focus();
  }

  #cancelarEdicion() {
    this.#editando = null;
    document.getElementById("com-usuario").value = "";
    document.getElementById("com-texto").value = "";
    document.getElementById("com-texto").dispatchEvent(new Event("input"));
    this.#foto = { ruta: null, archivo: null };
    this.#pintarFoto();
    this.#errorCampo("usuario", "");
    this.#errorCampo("texto", "");
    this.#errorCampo("foto", "");
    document.getElementById("com-form-titulo").textContent = "Añadir comentario";
    document.getElementById("com-enviar").textContent = "Añadir comentario";
    document.getElementById("com-cancelar").hidden = true;
    PanelFormato.mensaje(this.#mensajeForm, "");
    if (this.#comentarios.length) this.#pintarComentarios();
  }

  #formTieneDatos() {
    if (this.#editando) {
      const { usuario, texto } = ValidadorComentario.normalizar({
        usuario: document.getElementById("com-usuario").value, texto: document.getElementById("com-texto").value,
      });
      return usuario !== this.#editando.usuario || texto !== this.#editando.texto ||
        this.#foto.archivo !== null || this.#foto.ruta !== (this.#editando.foto_perfil_ruta ?? null);
    }
    return Boolean(document.getElementById("com-usuario").value.trim() || document.getElementById("com-texto").value.trim() || this.#foto.archivo);
  }

  async #elegirFoto(input) {
    const archivo = input.files?.[0];
    input.value = "";
    if (!archivo) return;
    try {
      await ValidadorVideo.validarImagen(archivo);
      this.#foto = { ruta: this.#foto.ruta, archivo };
      this.#errorCampo("foto", "");
      this.#pintarFoto();
    } catch (e) {
      this.#errorCampo("foto", PanelFormato.errorVisible(e, "No se pudo leer la imagen."));
    }
  }

  #pintarFoto() {
    const img = document.getElementById("com-foto-vista");
    const estado = document.getElementById("com-foto-estado");
    const quitar = document.getElementById("com-foto-quitar");
    const { ruta, archivo } = this.#foto;
    if (archivo) {
      img.hidden = true;
      img.removeAttribute("src");
      estado.textContent = `Se subirá al guardar: ${archivo.name} (${ValidadorVideo.tamano(archivo.size)})`;
    } else if (ruta) {
      img.src = this.#coms.urlFoto(ruta);
      img.hidden = false;
      estado.textContent = "Foto actual";
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      estado.textContent = "Sin foto: se mostrarán las iniciales";
    }
    quitar.hidden = !archivo && !ruta;
  }

  #errorCampo(campo, texto) {
    document.getElementById(`com-error-${campo}`).textContent = texto;
    const el = document.getElementById(`com-${campo}`);
    if (el && campo !== "foto") el.setAttribute("aria-invalid", texto ? "true" : "false");
  }

  async #enviar() {
    if (this.#ocupado || !this.#video) return;
    PanelFormato.mensaje(this.#mensajeForm, "");
    const datos = ValidadorComentario.normalizar({
      usuario: document.getElementById("com-usuario").value,
      texto: document.getElementById("com-texto").value,
    });
    const errores = ValidadorComentario.validar(datos);
    this.#errorCampo("usuario", errores.usuario ?? "");
    this.#errorCampo("texto", errores.texto ?? "");
    if (errores.usuario || errores.texto) {
      document.getElementById(errores.usuario ? "com-usuario" : "com-texto").focus();
      return;
    }

    const editando = this.#editando;
    const video = this.#video;
    this.#bloquearForm(true);
    PanelFormato.mensaje(this.#mensajeForm, "Guardando…");
    let fotoNueva = null;
    try {
      if (this.#foto.archivo) fotoNueva = await this.#coms.subirFoto(this.#foto.archivo);
      const foto_perfil_ruta = fotoNueva ?? this.#foto.ruta ?? null;

      if (editando) {
        const actualizado = await this.#coms.actualizar(editando.id, { ...datos, foto_perfil_ruta });
        const anterior = editando.foto_perfil_ruta;
        const fotoOk = anterior && anterior !== actualizado.foto_perfil_ruta ? await this.#coms.borrarFotoSiLibre(anterior) : true;
        this.#comentarios = this.#comentarios.map((c) => (c.id === actualizado.id ? actualizado : c));
        this.#cancelarEdicion();
        PanelFormato.mensaje(this.#mensajeForm, fotoOk ? "Comentario actualizado." : "Comentario actualizado, pero la foto anterior no se pudo borrar de Storage.", fotoOk ? "exito" : "error");
      } else {
        // El color se elige una sola vez, al crear, y se guarda para que no cambie al recargar.
        const creado = await this.#coms.crear({ ...datos, foto_perfil_ruta, video_id: video.id, color: AvatarIniciales.colorAlAzar() });
        if (this.#video?.id === video.id) this.#comentarios = [creado, ...this.#comentarios];
        this.#cancelarEdicion();
        PanelFormato.mensaje(this.#mensajeForm, "Comentario añadido.", "exito");
      }
      this.#pintarComentarios();
    } catch (e) {
      if (fotoNueva) await this.#coms.borrarFotoSiLibre(fotoNueva);
      PanelFormato.mensaje(this.#mensajeForm, `No se guardó el comentario. ${PanelFormato.errorVisible(e, "Ocurrió un error inesperado.")}`, "error");
    } finally {
      this.#bloquearForm(false);
    }
  }

  async #borrar(c) {
    if (this.#ocupado) return;
    const ok = await this.#dialogos.confirmar(`¿Borrar el comentario de @${c.usuario}? No se puede deshacer.`, "Borrar comentario");
    if (!ok) return;
    this.#ocupado = true;
    PanelFormato.mensaje(this.#mensajeComentarios, "Borrando…");
    try {
      const fotoOk = await this.#coms.borrar(c);
      this.#comentarios = this.#comentarios.filter((x) => x.id !== c.id);
      if (this.#editando?.id === c.id) this.#cancelarEdicion();
      this.#pintarComentarios();
      PanelFormato.mensaje(this.#mensajeComentarios, fotoOk ? "Comentario borrado." : "Comentario borrado, pero su foto no se pudo eliminar de Storage.", fotoOk ? "exito" : "error");
    } catch (e) {
      PanelFormato.mensaje(this.#mensajeComentarios, PanelFormato.errorVisible(e, "No se pudo borrar el comentario."), "error");
    } finally {
      this.#ocupado = false;
    }
  }

  #bloquearForm(si) {
    this.#ocupado = si;
    this.#form.disabled = si;
    document.getElementById("com-enviar").disabled = si;
    document.getElementById("com-cancelar").disabled = si;
  }
}
