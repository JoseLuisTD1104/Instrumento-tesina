"use strict";

/**
 * Feed de "corto". Solo se entra con el código de acceso que se proyecta en el salón: la Edge
 * Function "validar-codigo" entrega un pase (JWT de 25 min) que se guarda en sessionStorage y se manda
 * en Authorization a las demás funciones. Después del código, el participante lee el aviso de privacidad
 * y da sus datos ("registrar-participante"); sin ese registro el servidor no entrega el feed (403).
 * Los datos personales solo viajan en esa petición: no se guardan en sessionStorage, localStorage ni
 * cookies. Todo texto se pinta con nodos y textContent. No se guarda ninguna interacción del participante.
 */

/** El servidor rechazó el pase (401): hay que volver a la pantalla de acceso. */
class ErrorSinPase extends Error {}

/** El pase vale, pero la sesión aún no aceptó el aviso ni dio sus datos (403 falta_registro). */
class ErrorFaltaRegistro extends Error {}

/** El servidor rechazó los datos del registro (400 datos_invalidos): trae solo los nombres de campo. */
class ErrorDatosInvalidos extends Error {
  constructor(campos) {
    super("datos_invalidos");
    this.campos = Array.isArray(campos) ? campos.filter((c) => typeof c === "string") : [];
  }
}

/** Guarda el pase en sessionStorage: se pierde al cerrar la pestaña. */
class AlmacenDePase {
  static CLAVE = "corto_pase";
  static PATRON = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  /** El pase guardado, o null si no hay o ya venció (el servidor es quien decide si es válido). */
  leer() {
    try {
      const pase = window.sessionStorage.getItem(AlmacenDePase.CLAVE);
      if (!pase || !AlmacenDePase.PATRON.test(pase)) return null;
      const datos = JSON.parse(atob(pase.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (!Number.isInteger(datos?.exp) || datos.exp * 1000 <= Date.now()) {
        this.borrar();
        return null;
      }
      return pase;
    } catch {
      this.borrar();
      return null;
    }
  }

  guardar(pase) {
    if (!AlmacenDePase.PATRON.test(pase ?? "")) throw new Error("pase");
    window.sessionStorage.setItem(AlmacenDePase.CLAVE, pase);
  }

  borrar() {
    try { window.sessionStorage.removeItem(AlmacenDePase.CLAVE); } catch { /* sin almacenamiento */ }
  }
}

/** Llamadas a las Edge Functions del proyecto. */
class ClienteFunciones {
  #origen;
  #clave;

  constructor(config) {
    this.#origen = new URL(config.SUPABASE_URL).origin;
    this.#clave = config.SUPABASE_PUBLISHABLE_KEY;
  }

  get origen() { return this.#origen; }

  /**
   * Devuelve el JSON de la respuesta. 401 → ErrorSinPase; 403 falta_registro → ErrorFaltaRegistro;
   * 400 datos_invalidos → ErrorDatosInvalidos; cualquier otro error → Error.
   */
  async llamar(funcion, { metodo = "POST", cuerpo, pase, consulta } = {}) {
    const cabeceras = { apikey: this.#clave };
    if (cuerpo !== undefined) cabeceras["Content-Type"] = "application/json";
    if (pase) cabeceras.Authorization = `Bearer ${pase}`;
    const url = new URL(`${this.#origen}/functions/v1/${funcion}`);
    for (const [k, v] of Object.entries(consulta ?? {})) url.searchParams.set(k, v);
    const r = await fetch(url, {
      method: metodo,
      headers: cabeceras,
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (r.status === 401) throw new ErrorSinPase();
    if (!r.ok) {
      const datos = await r.json().catch(() => null);
      if (r.status === 403 && datos?.error === "falta_registro") throw new ErrorFaltaRegistro();
      if (r.status === 400 && datos?.error === "datos_invalidos") throw new ErrorDatosInvalidos(datos.campos);
      throw new Error("servicio");
    }
    return r.status === 204 ? null : r.json();
  }
}

/**
 * Mientras haya un pase, pregunta al servidor cada 15 s (y al volver a la pestaña) si sigue valiendo,
 * también mientras el participante lee el aviso y da sus datos. Si responde 401 (pase vencido o
 * sesiones cerradas desde el panel), avisa para salir. Si la red falla, no cierra nada: lo intenta otra
 * vez en la siguiente vuelta.
 */
class VigilanteDeSesion {
  static INTERVALO_MS = 15_000;

  #funciones;
  #pase;
  #alCerrarse;
  #intervalo = null;
  #revisando = false;
  #alVolver = () => { if (document.visibilityState === "visible") this.#revisar(); };

  constructor(funciones, pase, alCerrarse) {
    this.#funciones = funciones;
    this.#pase = pase;
    this.#alCerrarse = alCerrarse;
  }

  /** { registrada } si el pase sigue valiendo; lanza ErrorSinPase si no. No envía ni recibe datos personales. */
  static async estado(funciones, pase) {
    const datos = await funciones.llamar("registrar-participante", { cuerpo: { accion: "estado" }, pase });
    if (typeof datos?.registrada !== "boolean") throw new Error("estado");
    return datos;
  }

  iniciar() {
    this.#intervalo = window.setInterval(() => this.#revisar(), VigilanteDeSesion.INTERVALO_MS);
    document.addEventListener("visibilitychange", this.#alVolver);
  }

  detener() {
    window.clearInterval(this.#intervalo);
    this.#intervalo = null;
    document.removeEventListener("visibilitychange", this.#alVolver);
  }

  async #revisar() {
    if (this.#revisando || this.#intervalo === null) return;
    this.#revisando = true;
    try {
      await VigilanteDeSesion.estado(this.#funciones, this.#pase);
    } catch (e) {
      if (e instanceof ErrorSinPase) {
        this.detener();
        this.#alCerrarse();
      }
      // Cualquier otro error (red, servidor): se reintenta en la siguiente vuelta sin cerrar la sesión.
    } finally {
      this.#revisando = false;
    }
  }
}

/** Datos del feed, siempre con el pase. */
class FeedRepositorio {
  static RUTA_IMAGEN = /^(perfiles|portadas)\/[0-9a-f-]{36}\.(png|jpg|webp)$/;

  #funciones;
  #pase;

  constructor(funciones, pase) {
    this.#funciones = funciones;
    this.#pase = pase;
  }

  /** Solo publicados, del más antiguo al más reciente (lo resuelve "feed-videos"). */
  async listarPublicados() {
    const datos = await this.#funciones.llamar("feed-videos", { metodo: "GET", pase: this.#pase });
    if (!Array.isArray(datos)) throw new Error("lista");
    return datos;
  }

  urlImagen(ruta) {
    if (!ruta || !FeedRepositorio.RUTA_IMAGEN.test(ruta)) return null;
    return `${this.#funciones.origen}/storage/v1/object/public/imagenes/${ruta}`;
  }

  /** { url, venceEn } con la URL firmada que entrega "video-firmado". */
  async urlVideo(id) {
    const datos = await this.#funciones.llamar("video-firmado", { cuerpo: { id }, pase: this.#pase });
    if (typeof datos?.url !== "string" || !datos.url.startsWith(`${this.#funciones.origen}/storage/v1/object/sign/videos/`)) {
      throw new Error("firma");
    }
    const segundos = Number(datos.expira_en) > 0 ? Number(datos.expira_en) : 60;
    return { url: datos.url, venceEn: Date.now() + segundos * 1000 };
  }
}

/** Pantalla de acceso: pide el código de 8 dígitos y obtiene el pase. */
class PantallaDeAcceso {
  static MENSAJE = "Código no válido";

  #funciones;
  #seccion = document.getElementById("acceso");
  #form = document.getElementById("form-acceso");
  #campo = document.getElementById("codigo-acceso");
  #boton = document.getElementById("acceso-enviar");
  #error = document.getElementById("acceso-error");
  #aviso = document.getElementById("acceso-aviso");
  #alObtenerPase;
  #enviando = false;

  constructor(funciones, alObtenerPase) {
    this.#funciones = funciones;
    this.#alObtenerPase = alObtenerPase;
    this.#form.addEventListener("submit", (e) => { e.preventDefault(); this.#enviar(); });
    this.#campo.addEventListener("input", () => { this.#mostrarError(""); });
  }

  /** Muestra la pantalla; con `aviso` explica por qué se volvió a ella (p. ej., "Tu sesión se cerró"). */
  mostrar(aviso = "") {
    this.#campo.value = "";
    this.#mostrarError("");
    this.#aviso.textContent = aviso;
    this.#aviso.hidden = !aviso;
    this.#seccion.hidden = false;
    this.#campo.focus();
  }

  ocultar() {
    this.#seccion.hidden = true;
    this.#aviso.hidden = true;
  }

  /** Acepta pegar con espacios: se quitan todos antes de validar. */
  static normalizar(texto) {
    return String(texto ?? "").replace(/\s+/g, "");
  }

  async #enviar() {
    if (this.#enviando) return;
    const codigo = PantallaDeAcceso.normalizar(this.#campo.value);
    if (!/^\d{8}$/.test(codigo)) {
      this.#mostrarError(PantallaDeAcceso.MENSAJE);
      return;
    }
    this.#enviando = true;
    this.#boton.disabled = true;
    this.#mostrarError("");
    try {
      const datos = await this.#funciones.llamar("validar-codigo", { cuerpo: { codigo } });
      if (typeof datos?.pase !== "string") throw new Error("pase");
      this.#alObtenerPase(datos.pase);
    } catch {
      this.#mostrarError(PantallaDeAcceso.MENSAJE);
      this.#campo.select();
    } finally {
      this.#enviando = false;
      this.#boton.disabled = false;
    }
  }

  #mostrarError(texto) {
    this.#error.textContent = texto;
    this.#error.hidden = !texto;
  }
}

/** Pinta el aviso de privacidad (bloques de aviso-privacidad.js) solo con nodos y textContent. */
class RenderizadorDeAviso {
  static ETIQUETAS = Object.freeze({ titulo: "h1", fecha: "p", seccion: "h2", subtitulo: "h3", parrafo: "p" });

  static pintar(contenedor, bloques) {
    const nodos = bloques.map((b) => {
      if (b.tipo === "lista") {
        const ul = document.createElement("ul");
        for (const texto of b.elementos) {
          const li = document.createElement("li");
          li.textContent = texto;
          ul.append(li);
        }
        return ul;
      }
      const etiqueta = RenderizadorDeAviso.ETIQUETAS[b.tipo];
      if (!etiqueta) throw new Error("bloque");
      const nodo = document.createElement(etiqueta);
      nodo.className = `aviso-${b.tipo}`;
      nodo.textContent = b.texto;
      return nodo;
    });
    contenedor.replaceChildren(...nodos);
  }
}

/**
 * Reglas de los datos del participante. Son las mismas que aplica "registrar-participante"; el
 * servidor vuelve a validarlas, esto solo evita enviar algo que de antemano se sabe inválido.
 */
class ValidadorDeRegistro {
  static PROHIBIDOS = /[<>"&]/;
  static CONTROL = /\p{Cc}/u;
  static CAMPOS = Object.freeze({
    matricula: { maximo: 15, mensaje: "Escribe tu matrícula: de 6 a 15 letras o números, sin espacios ni guiones." },
    nombre: { maximo: 40, mensaje: "Escribe tu nombre de pila (hasta 40 caracteres, sin < > \" &)." },
    carrera: { maximo: 60, mensaje: "Escribe tu carrera (hasta 60 caracteres, sin < > \" &)." },
  });

  static matricula(valor) {
    return String(valor ?? "").trim().toUpperCase();
  }

  static texto(valor) {
    return String(valor ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  }

  static #textoValido(texto, maximo) {
    const largo = [...texto].length;
    return largo >= 1 && largo <= maximo && !ValidadorDeRegistro.PROHIBIDOS.test(texto) && !ValidadorDeRegistro.CONTROL.test(texto);
  }

  /** { datos, campos }: datos listos para enviar y la lista de campos inválidos (vacía si todo está bien). */
  static validar({ matricula, nombre, carrera }) {
    const datos = {
      matricula: ValidadorDeRegistro.matricula(matricula),
      nombre: ValidadorDeRegistro.texto(nombre),
      carrera: ValidadorDeRegistro.texto(carrera),
    };
    const campos = [];
    if (!/^[A-Z0-9]{6,15}$/.test(datos.matricula)) campos.push("matricula");
    if (!ValidadorDeRegistro.#textoValido(datos.nombre, 40)) campos.push("nombre");
    if (!ValidadorDeRegistro.#textoValido(datos.carrera, 60)) campos.push("carrera");
    return { datos, campos };
  }
}

/**
 * Pantalla de registro: pestañas "Aviso de privacidad" y "Tus datos", y debajo (visibles en ambas) la
 * casilla de aceptación y el botón "Estoy de acuerdo", que solo se activa con la casilla marcada.
 * Los datos solo viven en los campos y en la petición: al terminar (o al cerrar la sesión) se borran.
 */
class PantallaDeRegistro {
  static MENSAJE_FALLA = "No se pudo completar el registro. Intenta de nuevo.";
  static MENSAJE_VERSION = "El aviso de privacidad cambió. Recarga la página para leer la versión vigente.";

  #funciones;
  #pase = null;
  #alRegistrarse;
  #alPerderPase;
  #enviando = false;
  #seccion = document.getElementById("registro");
  #pestanas = [document.getElementById("tab-aviso"), document.getElementById("tab-datos")];
  #panelAviso = document.getElementById("panel-aviso");
  #panelDatos = document.getElementById("panel-datos");
  #acepto = document.getElementById("reg-acepto");
  #boton = document.getElementById("reg-enviar");
  #error = document.getElementById("reg-error");
  #campos = Object.fromEntries(Object.keys(ValidadorDeRegistro.CAMPOS).map((nombre) => [nombre, {
    entrada: document.getElementById(`reg-${nombre}`),
    error: document.getElementById(`reg-${nombre}-error`),
    contador: document.getElementById(`reg-${nombre}-contador`),
  }]));

  constructor(funciones, alRegistrarse, alPerderPase) {
    this.#funciones = funciones;
    this.#alRegistrarse = alRegistrarse;
    this.#alPerderPase = alPerderPase;
    RenderizadorDeAviso.pintar(this.#panelAviso, AVISO_PRIVACIDAD.BLOQUES);
    this.#pestanas.forEach((tab, i) => {
      tab.addEventListener("click", () => this.#elegir(i));
      tab.addEventListener("keydown", (e) => this.#teclaPestana(e, i));
    });
    this.#acepto.addEventListener("change", () => this.#actualizarBoton());
    this.#boton.addEventListener("click", () => this.#enviar());
    this.#panelDatos.addEventListener("submit", (e) => { e.preventDefault(); this.#enviar(); });
    for (const [nombre, campo] of Object.entries(this.#campos)) {
      campo.entrada.addEventListener("input", () => {
        this.#contar(nombre);
        this.#marcar(nombre, false);
      });
    }
  }

  mostrar(pase) {
    this.#pase = pase;
    this.limpiar();
    this.#seccion.hidden = false;
    this.#elegir(0, false);
    this.#panelAviso.scrollTop = 0;
  }

  ocultar() {
    this.#seccion.hidden = true;
  }

  /** Borra todo lo escrito (datos personales incluidos) y deja la pantalla como nueva. */
  limpiar() {
    for (const nombre of Object.keys(this.#campos)) {
      this.#campos[nombre].entrada.value = "";
      this.#contar(nombre);
      this.#marcar(nombre, false);
    }
    this.#acepto.checked = false;
    this.#mostrarError("");
    this.#actualizarBoton();
  }

  #elegir(i, enfocar = true) {
    this.#pestanas.forEach((tab, j) => {
      tab.setAttribute("aria-selected", String(i === j));
      tab.tabIndex = i === j ? 0 : -1;
    });
    this.#panelAviso.hidden = i !== 0;
    this.#panelDatos.hidden = i !== 1;
    if (enfocar) this.#pestanas[i].focus();
  }

  #teclaPestana(e, i) {
    const total = this.#pestanas.length;
    const destino = { ArrowRight: (i + 1) % total, ArrowLeft: (i - 1 + total) % total, Home: 0, End: total - 1 }[e.key];
    if (destino === undefined) return;
    e.preventDefault();
    this.#elegir(destino);
  }

  #actualizarBoton() {
    this.#boton.disabled = this.#enviando || !this.#acepto.checked;
  }

  #contar(nombre) {
    const { entrada, contador } = this.#campos[nombre];
    contador.textContent = `${[...entrada.value].length}/${ValidadorDeRegistro.CAMPOS[nombre].maximo}`;
  }

  #marcar(nombre, invalido) {
    const { entrada, error } = this.#campos[nombre];
    entrada.setAttribute("aria-invalid", String(invalido));
    error.textContent = invalido ? ValidadorDeRegistro.CAMPOS[nombre].mensaje : "";
    error.hidden = !invalido;
  }

  /** Marca los campos inválidos, pasa a "Tus datos" y enfoca el primero. */
  #mostrarInvalidos(campos) {
    for (const nombre of Object.keys(this.#campos)) this.#marcar(nombre, campos.includes(nombre));
    const primero = Object.keys(this.#campos).find((n) => campos.includes(n));
    if (!primero) return;
    this.#elegir(1, false);
    this.#campos[primero].entrada.focus();
  }

  async #enviar() {
    if (this.#enviando || !this.#acepto.checked || !this.#pase) return;
    this.#enviando = true;
    this.#actualizarBoton();
    this.#mostrarError("");
    try {
      const { datos, campos } = ValidadorDeRegistro.validar({
        matricula: this.#campos.matricula.entrada.value,
        nombre: this.#campos.nombre.entrada.value,
        carrera: this.#campos.carrera.entrada.value,
      });
      if (campos.length) {
        this.#mostrarInvalidos(campos);
        return;
      }
      for (const nombre of Object.keys(this.#campos)) this.#marcar(nombre, false);
      await this.#funciones.llamar("registrar-participante", {
        cuerpo: { ...datos, version_terminos: AVISO_PRIVACIDAD.VERSION },
        pase: this.#pase,
      });
      this.limpiar();
      this.#alRegistrarse();
    } catch (e) {
      if (e instanceof ErrorSinPase) { this.#alPerderPase(); return; }
      if (e instanceof ErrorDatosInvalidos) {
        if (e.campos.includes("version_terminos")) this.#mostrarError(PantallaDeRegistro.MENSAJE_VERSION);
        else if (e.campos.length) this.#mostrarInvalidos(e.campos);
        else this.#mostrarError(PantallaDeRegistro.MENSAJE_FALLA);
        return;
      }
      this.#mostrarError(PantallaDeRegistro.MENSAJE_FALLA);
    } finally {
      this.#enviando = false;
      this.#actualizarBoton();
    }
  }

  #mostrarError(texto) {
    this.#error.textContent = texto;
    this.#error.hidden = !texto;
  }
}

/**
 * Botón de enlace estilo anuncio de un video. Aparece según el tiempo del propio video (currentTime):
 * invisible y sin poder pulsarse antes del segundo 8, degradado de opacidad del 8 al 10, y desde el 10
 * completo y pulsable. Completo, se queda visible el resto del video y en el bucle. No registra clics.
 */
class BarraDeEnlace {
  static INICIO_S = 8;
  static FIN_S = 10;
  static PATRON_COLOR = /^#[0-9A-F]{6}$/i;
  static CARACTERES_PROHIBIDOS = /[\s"'<>]/;

  #elemento;
  #video;
  #opacidad = 0;
  #completa = false;
  #ultimoTiempo = 0;
  #cuadro = null;

  /** Devuelve la barra, o null si el video no tiene un enlace activo con texto y URL https:// válidos. */
  static crear(datos, video, elemento) {
    if (datos?.enlace_activo !== true) return null;
    const texto = String(datos.enlace_texto ?? "").trim();
    const url = String(datos.enlace_url ?? "").trim();
    if (!texto || !BarraDeEnlace.esUrlSegura(url)) return null;
    return new BarraDeEnlace(texto, url, datos.enlace_color, video, elemento);
  }

  static esUrlSegura(url) {
    if (!url.startsWith("https://") || url.length > 500 || BarraDeEnlace.CARACTERES_PROHIBIDOS.test(url)) return false;
    try {
      const u = new URL(url);
      return u.protocol === "https:" && Boolean(u.hostname);
    } catch {
      return false;
    }
  }

  /** El color de cada video si es #RRGGBB; si no, el color de acento de corto. */
  static colorSeguro(color) {
    if (BarraDeEnlace.PATRON_COLOR.test(color ?? "")) return color;
    return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff3b5c";
  }

  constructor(texto, url, color, video, elemento) {
    this.#elemento = elemento;
    this.#video = video;
    elemento.href = url;
    elemento.target = "_blank";
    elemento.rel = "noopener noreferrer";
    elemento.referrerPolicy = "no-referrer";
    elemento.querySelector("[data-enlace-texto]").textContent = texto; // nunca innerHTML
    elemento.style.backgroundColor = BarraDeEnlace.colorSeguro(color);
    this.#bloquear();
    elemento.hidden = false;

    // Mientras el video avanza se anima cuadro a cuadro; en pausa, la aparición también se detiene.
    video.addEventListener("play", () => this.#animar());
    video.addEventListener("pause", () => this.#detener());
    for (const evento of ["timeupdate", "seeked", "loadedmetadata"]) video.addEventListener(evento, () => this.#actualizar());
  }

  #animar() {
    this.#detener();
    const paso = () => {
      this.#actualizar();
      if (!this.#completa && !this.#video.paused) this.#cuadro = requestAnimationFrame(paso);
    };
    this.#cuadro = requestAnimationFrame(paso);
  }

  #detener() {
    if (this.#cuadro !== null) cancelAnimationFrame(this.#cuadro);
    this.#cuadro = null;
  }

  #actualizar() {
    if (this.#completa) return;
    const t = this.#video.currentTime || 0;
    // Un video de entre 8 y 10 s nunca llega al segundo 10: al volver a empezar se da por completo.
    if (t + 0.5 < this.#ultimoTiempo && this.#ultimoTiempo >= BarraDeEnlace.INICIO_S) {
      this.#completar();
      return;
    }
    this.#ultimoTiempo = t;
    const avance = (t - BarraDeEnlace.INICIO_S) / (BarraDeEnlace.FIN_S - BarraDeEnlace.INICIO_S);
    if (avance >= 1) {
      this.#completar();
      return;
    }
    this.#opacidad = Math.max(this.#opacidad, Math.min(Math.max(avance, 0), 1));
    this.#elemento.style.opacity = String(this.#opacidad);
  }

  #bloquear() {
    this.#elemento.style.opacity = "0";
    this.#elemento.classList.remove("activa");
    this.#elemento.tabIndex = -1;
    this.#elemento.setAttribute("aria-hidden", "true");
  }

  #completar() {
    this.#completa = true;
    this.#detener();
    this.#elemento.style.opacity = "1";
    this.#elemento.classList.add("activa");
    this.#elemento.tabIndex = 0;
    this.#elemento.removeAttribute("aria-hidden");
  }
}

/** Un video del feed: pide su URL firmada, la renueva al caducar y bloquea menús y descargas. */
class VideoDelFeed {
  static MARGEN_MS = 20_000; // se pide una URL nueva si a la actual le quedan menos de 20 s

  #repo;
  #datos;
  #feed;
  #video;
  #aviso;
  #progreso;
  #firma = null;
  #pidiendo = null;
  #reintentos = 0;
  #activo = false;
  #pausadoPorUsuario = false;
  #destruido = false;
  raiz;

  constructor(repo, datos, feed) {
    this.#repo = repo;
    this.#datos = datos;
    this.#feed = feed;
    this.raiz = document.getElementById("tpl-slide").content.firstElementChild.cloneNode(true);
    this.#video = this.raiz.querySelector("video");
    this.#aviso = this.raiz.querySelector("[data-aviso]");
    this.#progreso = this.raiz.querySelector("[data-progreso]");
    this.#pintarDatos();
    BarraDeEnlace.crear(datos, this.#video, this.raiz.querySelector("[data-enlace]"));
    this.#protegerVideo();
    this.#conectarControles();
  }

  get id() { return this.#datos.id; }

  async activar() {
    this.#activo = true;
    this.#pausadoPorUsuario = false;
    await this.#asegurarFuente();
    if (this.#activo) this.#reproducir();
  }

  desactivar() {
    this.#activo = false;
    this.#video.pause();
  }

  /** Precarga la URL del siguiente video para que empiece sin espera. */
  async precargar() {
    if (!this.#activo) await this.#asegurarFuente(false);
  }

  /** Al cerrarse la sesión: detiene el video y suelta su URL firmada. */
  destruir() {
    this.#destruido = true;
    this.#activo = false;
    this.#video.pause();
    this.#video.removeAttribute("src");
    this.#video.load();
    this.#firma = null;
  }

  /** Suelta la URL cuando el video queda lejos: menos tiempo expuesta y menos memoria. */
  liberar() {
    if (this.#activo || !this.#video.getAttribute("src")) return;
    this.#video.removeAttribute("src");
    this.#video.load();
    this.#firma = null;
  }

  aplicarSonido(conSonido) {
    this.#video.muted = !conSonido;
    this.raiz.querySelector("[data-icono-mudo]").hidden = conSonido;
    this.raiz.querySelector("[data-icono-sonido]").hidden = !conSonido;
    this.raiz.querySelector("[data-sonido]").setAttribute("aria-label", conSonido ? "Silenciar" : "Activar sonido");
  }

  // ------------------------------------------------------------------ datos
  #pintarDatos() {
    const d = this.#datos;
    const usuario = this.raiz.querySelector("[data-usuario]");
    usuario.textContent = d.usuario ? `@${d.usuario}` : "";

    const avatar = this.raiz.querySelector("[data-avatar]");
    const urlAvatar = this.#repo.urlImagen(d.foto_perfil_ruta);
    if (urlAvatar) { avatar.src = urlAvatar; avatar.hidden = false; }

    const portada = this.raiz.querySelector("[data-portada]");
    const urlPortada = this.#repo.urlImagen(d.portada_sonido_ruta);
    if (urlPortada) { portada.src = urlPortada; portada.hidden = false; }

    this.#pintarDescripcion(this.raiz.querySelector("[data-descripcion]"), d.descripcion ?? "");

    const sonido = [d.sonido_nombre, d.sonido_autor].filter(Boolean).join(" · ");
    this.raiz.querySelector("[data-sonido-nombre]").textContent = sonido;
    this.raiz.querySelector("[data-sonido-texto]").hidden = !sonido;

    for (const img of this.raiz.querySelectorAll("img")) {
      img.draggable = false;
      img.addEventListener("error", () => { img.hidden = true; }, { once: true });
    }
  }

  /** Hashtags en negritas, construidos con nodos de texto (nunca innerHTML). */
  #pintarDescripcion(caja, texto) {
    const partes = texto.split(/(#[\p{L}\p{N}_]+)/u);
    caja.replaceChildren(...partes.filter(Boolean).map((parte) => {
      if (!parte.startsWith("#")) return document.createTextNode(parte);
      const b = document.createElement("b");
      b.textContent = parte;
      return b;
    }));
  }

  // -------------------------------------------------------------- protección
  #protegerVideo() {
    const v = this.#video;
    v.controls = false;
    v.disablePictureInPicture = true;
    v.disableRemotePlayback = true;
    // Sin menú contextual ni arrastre sobre el reproductor (ni sobre el video ni sobre su capa).
    for (const el of [this.raiz.querySelector(".player"), v]) {
      el.addEventListener("contextmenu", (e) => e.preventDefault());
      el.addEventListener("dragstart", (e) => e.preventDefault());
    }
    // Si el navegador intenta abrir imagen en imagen, se sale de inmediato.
    v.addEventListener("enterpictureinpicture", () => { document.exitPictureInPicture?.().catch(() => {}); });
    // URL caducada u otro error de red: se pide una nueva y se sigue desde el mismo segundo.
    v.addEventListener("error", () => this.#recuperar());
    v.addEventListener("timeupdate", () => {
      const p = v.duration ? v.currentTime / v.duration : 0;
      this.#progreso.style.transform = `scaleX(${p})`;
    });
  }

  #conectarControles() {
    const alternar = () => {
      if (this.#video.paused) { this.#pausadoPorUsuario = false; this.#reproducir(); }
      else { this.#pausadoPorUsuario = true; this.#video.pause(); }
    };
    this.raiz.querySelector("[data-escudo]").addEventListener("click", alternar);
    this.raiz.querySelector("[data-pausa]").addEventListener("click", alternar);
    this.raiz.querySelector("[data-sonido]").addEventListener("click", () => this.#feed.alternarSonido());
    this.#video.addEventListener("play", () => this.#iconoPausa(true));
    this.#video.addEventListener("pause", () => this.#iconoPausa(false));
  }

  #iconoPausa(reproduciendo) {
    this.raiz.querySelector("[data-icono-pausa]").hidden = !reproduciendo;
    this.raiz.querySelector("[data-icono-play]").hidden = reproduciendo;
    this.raiz.querySelector("[data-pausa]").setAttribute("aria-label", reproduciendo ? "Pausar" : "Reproducir");
  }

  // ------------------------------------------------------------ reproducción
  async #asegurarFuente(mostrarAviso = true) {
    if (this.#firma && this.#firma.venceEn - Date.now() > VideoDelFeed.MARGEN_MS) return;
    await this.#nuevaFirma(mostrarAviso);
  }

  async #nuevaFirma(mostrarAviso = true) {
    if (this.#pidiendo) return this.#pidiendo;
    this.#pidiendo = (async () => {
      try {
        const segundo = this.#video.currentTime || 0;
        this.#firma = await this.#repo.urlVideo(this.#datos.id);
        if (this.#destruido) { this.#firma = null; return; } // la sesión se cerró mientras se firmaba
        this.#video.preload = "auto";
        this.#video.src = this.#firma.url; // solo en el atributo src del reproductor, nunca en texto ni enlaces
        if (segundo > 0) {
          this.#video.addEventListener("loadedmetadata", () => { this.#video.currentTime = segundo; }, { once: true });
        }
        this.#aviso.hidden = true;
      } catch (e) {
        this.#firma = null;
        if (e instanceof ErrorSinPase) { this.#feed.perderPase(); return; }
        if (mostrarAviso) this.#mostrarAviso("Este video no está disponible en este momento.");
      } finally {
        this.#pidiendo = null;
      }
    })();
    return this.#pidiendo;
  }

  async #recuperar() {
    if (!this.#activo && !this.#video.getAttribute("src")) return;
    if (this.#reintentos >= 3) { this.#mostrarAviso("No se pudo reproducir este video. Recarga la página."); return; }
    this.#reintentos++;
    this.#firma = null;
    await this.#nuevaFirma();
    if (this.#activo) this.#reproducir();
  }

  #reproducir() {
    if (this.#pausadoPorUsuario || !this.#video.getAttribute("src")) return;
    this.#video.play().then(() => { this.#reintentos = 0; }).catch(() => {
      // El navegador bloqueó la reproducción con sonido: se intenta en silencio.
      if (!this.#video.muted) { this.#feed.silenciar(); this.#video.play().catch(() => {}); }
    });
  }

  #mostrarAviso(texto) {
    this.#aviso.textContent = texto;
    this.#aviso.hidden = false;
  }
}

/** Página del feed: arma la cola, activa el video visible y maneja la navegación. */
class FeedPagina {
  #repo;
  #alPerderPase;
  #contenedor = document.getElementById("feed");
  #estado = document.getElementById("feed-estado");
  #anterior = document.getElementById("nav-anterior");
  #siguiente = document.getElementById("nav-siguiente");
  #videos = [];
  #indice = -1;
  #conSonido = false;
  #observador = null;
  #escuchas = new AbortController(); // permite quitar todos los escuchadores al vaciar

  #alFaltarRegistro;

  constructor(repo, alPerderPase, alFaltarRegistro) {
    this.#repo = repo;
    this.#alPerderPase = alPerderPase;
    this.#alFaltarRegistro = alFaltarRegistro;
  }

  /** El servidor rechazó el pase (vencido o alterado): se detiene todo y se vuelve al acceso. */
  perderPase() {
    this.#videos.forEach((v) => v.desactivar());
    this.#alPerderPase();
  }

  /** Pausa y quita todos los videos (src y elementos) y los escuchadores. La página queda vacía. */
  vaciar() {
    this.#escuchas.abort();
    this.#observador?.disconnect();
    this.#videos.forEach((v) => v.destruir());
    this.#videos = [];
    this.#estado.textContent = "Cargando videos…";
    this.#contenedor.replaceChildren(this.#estado);
    this.#anterior.disabled = true;
    this.#siguiente.disabled = true;
  }

  async iniciar() {
    // Bloqueo general de arrastre y del menú contextual sobre medios.
    document.addEventListener("contextmenu", (e) => {
      if (e.target.closest?.(".player, video, img")) e.preventDefault();
    }, { signal: this.#escuchas.signal });
    let filas;
    try {
      filas = await this.#repo.listarPublicados();
    } catch (e) {
      if (e instanceof ErrorSinPase) { this.perderPase(); return; }
      if (e instanceof ErrorFaltaRegistro) { this.#alFaltarRegistro(); return; }
      this.#mostrarEstado("No se pudieron cargar los videos. Recarga la página.");
      return;
    }
    if (this.#escuchas.signal.aborted) return; // la sesión se cerró mientras cargaba
    if (!filas.length) {
      this.#mostrarEstado("Todavía no hay videos publicados.");
      return;
    }
    this.#videos = filas.map((d) => new VideoDelFeed(this.#repo, d, this));
    this.#estado.remove();
    this.#contenedor.replaceChildren(...this.#videos.map((v) => v.raiz));
    this.#videos.forEach((v) => v.aplicarSonido(this.#conSonido));
    this.#observar();
    this.#conectarNavegacion();
  }

  alternarSonido() {
    this.#conSonido = !this.#conSonido;
    this.#videos.forEach((v) => v.aplicarSonido(this.#conSonido));
  }

  silenciar() {
    this.#conSonido = false;
    this.#videos.forEach((v) => v.aplicarSonido(false));
  }

  #observar() {
    const observador = this.#observador = new IntersectionObserver((entradas) => {
      for (const e of entradas) {
        if (e.isIntersecting && e.intersectionRatio >= 0.6) this.#activar(this.#videos.findIndex((v) => v.raiz === e.target));
      }
    }, { root: this.#contenedor, threshold: [0.6] });
    this.#videos.forEach((v) => observador.observe(v.raiz));
  }

  #activar(i) {
    if (i < 0 || i === this.#indice) return;
    this.#indice = i;
    this.#videos.forEach((v, j) => {
      if (j === i) v.activar();
      else {
        v.desactivar();
        if (Math.abs(j - i) > 1) v.liberar();
      }
    });
    this.#videos[i + 1]?.precargar();
    this.#anterior.disabled = i === 0;
    this.#siguiente.disabled = i === this.#videos.length - 1;
  }

  #irA(i) {
    const destino = this.#videos[i];
    if (destino) destino.raiz.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  #conectarNavegacion() {
    const opciones = { signal: this.#escuchas.signal };
    this.#anterior.addEventListener("click", () => this.#irA(this.#indice - 1), opciones);
    this.#siguiente.addEventListener("click", () => this.#irA(this.#indice + 1), opciones);
    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); this.#irA(this.#indice + 1); }
      if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); this.#irA(this.#indice - 1); }
    }, opciones);
  }

  #mostrarEstado(texto) {
    this.#estado.textContent = texto;
  }
}

/**
 * Arranque y flujo: código → aviso y datos → feed. Sin pase solo existe la pantalla de acceso; con
 * pase, el vigilante revisa la sesión todo el tiempo (también durante el registro).
 */
class AppFeed {
  static AVISO_SESION_CERRADA = "Tu sesión se cerró";
  static PANTALLAS_FEED = ["cabecera", "nav", "feed"];

  #funciones;
  #almacen = new AlmacenDePase();
  #acceso;
  #registro;
  #pase = null;
  #pagina = null;
  #vigilante = null;

  constructor(config) {
    this.#funciones = new ClienteFunciones(config);
    this.#acceso = new PantallaDeAcceso(this.#funciones, (pase) => this.#entrar(pase));
    this.#registro = new PantallaDeRegistro(this.#funciones, () => this.#mostrarFeed(), () => this.#cerrarSesion());
  }

  iniciar() {
    const pase = this.#almacen.leer();
    if (pase) this.#reanudar(pase);
    else this.#acceso.mostrar();
  }

  /** Código válido: se guarda el pase y se pasa al aviso y los datos. */
  #entrar(pase) {
    this.#almacen.guardar(pase);
    this.#acceso.ocultar();
    this.#abrirSesion(pase);
    this.#registro.mostrar(pase);
  }

  /** Recarga con un pase guardado: el servidor dice si falta el registro o si ya puede ver el feed. */
  async #reanudar(pase) {
    this.#abrirSesion(pase);
    try {
      const { registrada } = await VigilanteDeSesion.estado(this.#funciones, pase);
      if (this.#pase !== pase) return;
      if (registrada) this.#mostrarFeed();
      else this.#registro.mostrar(pase);
    } catch (e) {
      if (this.#pase !== pase) return;
      if (e instanceof ErrorSinPase) this.#cerrarSesion();
      else this.#mostrarFeed(); // red o servidor: el feed lo intenta y, si falta el registro, regresa a él
    }
  }

  #abrirSesion(pase) {
    this.#pase = pase;
    this.#vigilante = new VigilanteDeSesion(this.#funciones, pase, () => this.#cerrarSesion());
    this.#vigilante.iniciar();
  }

  #mostrarFeed() {
    if (!this.#pase || this.#pagina) return;
    this.#registro.ocultar();
    for (const id of AppFeed.PANTALLAS_FEED) document.getElementById(id).hidden = false;
    this.#pagina = new FeedPagina(new FeedRepositorio(this.#funciones, this.#pase), () => this.#cerrarSesion(), () => this.#volverARegistro());
    this.#pagina.iniciar();
  }

  /** El servidor dice que la sesión aún no se registra: se quita el feed y se muestra el registro. */
  #volverARegistro() {
    if (!this.#pase) return;
    this.#quitarFeed();
    this.#registro.mostrar(this.#pase);
  }

  #quitarFeed() {
    this.#pagina?.vaciar();
    this.#pagina = null;
    for (const id of AppFeed.PANTALLAS_FEED) document.getElementById(id).hidden = true;
  }

  /** Pase rechazado (vencido o sesiones cerradas): borra el pase y lo escrito, y vuelve al acceso. */
  #cerrarSesion() {
    if (!this.#pase) return; // ya se cerró (pueden avisar el vigilante y una llamada a la vez)
    this.#pase = null;
    this.#almacen.borrar();
    this.#vigilante?.detener();
    this.#vigilante = null;
    this.#quitarFeed();
    this.#registro.limpiar();
    this.#registro.ocultar();
    this.#acceso.mostrar(AppFeed.AVISO_SESION_CERRADA);
  }
}

(() => {
  if (window.top !== window.self) { document.documentElement.textContent = ""; return; }
  try {
    const config = window.CORTO_CONFIG;
    if (!config?.SUPABASE_URL || !config?.SUPABASE_PUBLISHABLE_KEY) throw new Error("config");
    new AppFeed(config).iniciar();
  } catch {
    const error = document.getElementById("acceso-error");
    document.getElementById("acceso").hidden = false;
    error.textContent = "No se pudo cargar la página. Recarga e intenta de nuevo.";
    error.hidden = false;
  }
})();
