"use strict";

/**
 * Feed de "corto". Solo se entra con el código de acceso que se proyecta en el salón: la Edge
 * Function "validar-codigo" entrega un pase (JWT de 25 min) que se guarda en sessionStorage y se manda
 * en Authorization a las demás funciones. Después del código, el participante lee el aviso de privacidad
 * y da sus datos ("registrar-participante"); sin ese registro el servidor no entrega el feed (403).
 * Los datos personales solo viajan en esa petición: no se guardan en sessionStorage, localStorage ni
 * cookies. Todo texto se pinta con nodos y textContent.
 * Cada toque en el feed se manda a "registrar-interaccion" (sin datos personales: el servidor pone el código
 * anónimo). Las métricas y el estado de los botones viven solo en memoria, nunca en el almacenamiento.
 * La etapa del participante (instrucción, fase a ciegas, siguientes) y el orden de los videos viven solo en
 * el servidor: al cargar, "feed-videos" dice la etapa y entrega solo el video actual y el siguiente. En la
 * fase a ciegas solo se avanza: al pasar de video se mide y se manda a "registrar-visualizacion", y el
 * siguiente aparece cuando el servidor lo confirma. Recargar vuelve al mismo video, nunca a uno anterior.
 * En PC solo se avanza con el botón ↓ y la tecla ↓ (la rueda y el panel táctil no mueven el feed); en
 * celular, deslizando hacia arriba. Después siguen el reconocimiento de actores, "¿harías lo que te pide?",
 * la revelación y "¿cuáles eran deepfake?": el contenido lo da "contenido-etapa" y cada respuesta va a
 * "responder-etapa" con ids fijos. Las selecciones viven solo en memoria hasta pulsar Aceptar.
 */

/** El servidor rechazó el pase (401): hay que volver a la pantalla de acceso. */
class ErrorSinPase extends Error {}

/** El pase vale, pero la sesión aún no aceptó el aviso ni dio sus datos (403 falta_registro). */
class ErrorFaltaRegistro extends Error {}

/** Respuesta no exitosa del servidor, con su estado HTTP (sirve para decidir si conviene reintentar). */
class ErrorDeServicio extends Error {
  constructor(estado) {
    super("servicio");
    this.estado = estado;
  }
}

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
   * 400 datos_invalidos → ErrorDatosInvalidos; cualquier otra respuesta → ErrorDeServicio(estado).
   * Un fallo de red llega como el error de fetch.
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
      throw new ErrorDeServicio(r.status);
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
  static RUTA_IMAGEN = /^(perfiles|portadas|comentarios)\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
  static MAX_VIDEOS = 2;
  static MAX_ELEMENTOS = 50;
  static PATRON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  #funciones;
  #pase;

  constructor(funciones, pase) {
    this.#funciones = funciones;
    this.#pase = pase;
  }

  /** { etapa, posicion, total } con el formato esperado; si no, lanza. */
  static #avance(datos) {
    if (typeof datos?.etapa !== "string" || !Number.isInteger(datos.posicion) || !Number.isInteger(datos.total)) throw new Error("avance");
    return { etapa: datos.etapa, posicion: datos.posicion, total: datos.total };
  }

  /** { etapa, posicion, total, videos }: en la fase a ciegas, solo el video actual y el siguiente. */
  async estado() {
    const datos = await this.#funciones.llamar("feed-videos", { metodo: "GET", pase: this.#pase });
    const avance = FeedRepositorio.#avance(datos);
    if (!Array.isArray(datos.videos) || datos.videos.length > FeedRepositorio.MAX_VIDEOS) throw new Error("videos");
    return { ...avance, videos: datos.videos };
  }

  /**
   * Contenido de la etapa actual según "contenido-etapa": { etapa, elementos: [{ id, url }] } en "conoce",
   * "convencio" y "memoria"; { etapa, segundos } en "revelacion"; { etapa } en las demás. url es null en un
   * video sin miniatura; en "conoce" la lista puede ir vacía (ningún video tiene actor). Lanza si el
   * formato no es el esperado o alguna URL no es una firma del bucket "reconocimiento".
   */
  async contenidoEtapa() {
    const datos = await this.#funciones.llamar("contenido-etapa", { metodo: "GET", pase: this.#pase });
    const etapa = datos?.etapa;
    if (typeof etapa !== "string") throw new Error("etapa");
    const prefijo = `${this.#funciones.origen}/storage/v1/object/sign/reconocimiento/`;
    const elementos = (lista, campo, { minimo, sinUrl }) => {
      if (!Array.isArray(lista) || lista.length < minimo || lista.length > FeedRepositorio.MAX_ELEMENTOS) throw new Error("elementos");
      return lista.map((e) => {
        if (!FeedRepositorio.PATRON_ID.test(e?.id ?? "")) throw new Error("elemento");
        const url = e[campo];
        if (url === null && sinUrl) return { id: e.id, url: null };
        if (typeof url !== "string" || !url.startsWith(prefijo)) throw new Error("elemento");
        return { id: e.id, url };
      });
    };
    if (etapa === "conoce") return { etapa, elementos: elementos(datos.actores, "cara_url", { minimo: 0, sinUrl: false }) };
    if (etapa === "convencio" || etapa === "memoria") {
      return { etapa, elementos: elementos(datos.videos, "miniatura_url", { minimo: 1, sinUrl: true }) };
    }
    if (etapa === "revelacion") {
      if (!Number.isInteger(datos.segundos_transcurridos) || datos.segundos_transcurridos < 0) throw new Error("segundos");
      return { etapa, segundos: datos.segundos_transcurridos };
    }
    return { etapa };
  }

  /** Respuesta de la etapa actual; devuelve la etapa nueva que confirma el servidor. */
  async responderEtapa(cuerpo) {
    const datos = await this.#funciones.llamar("responder-etapa", { cuerpo, pase: this.#pase });
    if (typeof datos?.etapa !== "string") throw new Error("etapa");
    return datos.etapa;
  }

  /** De la instrucción a la fase a ciegas (204 sin cuerpo). */
  async comenzar() {
    await this.#funciones.llamar("avanzar-etapa", { cuerpo: { accion: "comenzar" }, pase: this.#pase });
  }

  /** Medición del video actual; devuelve { etapa, posicion, total } ya avanzados por el servidor. */
  async registrarVisualizacion(cuerpo) {
    return FeedRepositorio.#avance(await this.#funciones.llamar("registrar-visualizacion", { cuerpo, pase: this.#pase }));
  }

  urlImagen(ruta) {
    if (!ruta || !FeedRepositorio.RUTA_IMAGEN.test(ruta)) return null;
    return `${this.#funciones.origen}/storage/v1/object/public/imagenes/${ruta}`;
  }

  /** Una interacción del participante (204 sin cuerpo). El código anónimo lo pone el servidor. */
  async registrarInteraccion(cuerpo) {
    await this.#funciones.llamar("registrar-interaccion", { cuerpo, pase: this.#pase });
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
    edad: { minimo: 17, maximo: 99, mensaje: "Escribe tu edad: un número entero de 17 a 99." },
    semestre: { minimo: 1, maximo: 14, mensaje: "Escribe tu semestre: un número entero del 1 al 14." },
  });

  static matricula(valor) {
    return String(valor ?? "").trim().toUpperCase();
  }

  static texto(valor) {
    return String(valor ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  }

  /** Entero de 1 o 2 cifras dentro del rango, o null. */
  static entero(valor, minimo, maximo) {
    const texto = String(valor ?? "").trim();
    if (!/^\d{1,2}$/.test(texto)) return null;
    const n = Number(texto);
    return n >= minimo && n <= maximo ? n : null;
  }

  static #textoValido(texto, maximo) {
    const largo = [...texto].length;
    return largo >= 1 && largo <= maximo && !ValidadorDeRegistro.PROHIBIDOS.test(texto) && !ValidadorDeRegistro.CONTROL.test(texto);
  }

  /** { datos, campos }: datos listos para enviar y la lista de campos inválidos (vacía si todo está bien). */
  static validar({ matricula, nombre, carrera, edad, semestre }) {
    const { edad: reglaEdad, semestre: reglaSemestre } = ValidadorDeRegistro.CAMPOS;
    const datos = {
      matricula: ValidadorDeRegistro.matricula(matricula),
      nombre: ValidadorDeRegistro.texto(nombre),
      carrera: ValidadorDeRegistro.texto(carrera),
      edad: ValidadorDeRegistro.entero(edad, reglaEdad.minimo, reglaEdad.maximo),
      semestre: ValidadorDeRegistro.entero(semestre, reglaSemestre.minimo, reglaSemestre.maximo),
    };
    const campos = [];
    if (!/^[A-Z0-9]{6,15}$/.test(datos.matricula)) campos.push("matricula");
    if (!ValidadorDeRegistro.#textoValido(datos.nombre, 40)) campos.push("nombre");
    if (!ValidadorDeRegistro.#textoValido(datos.carrera, 60)) campos.push("carrera");
    if (datos.edad === null) campos.push("edad");
    if (datos.semestre === null) campos.push("semestre");
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
    if (!contador) return; // edad y semestre no llevan contador
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
      const { datos, campos } = ValidadorDeRegistro.validar(
        Object.fromEntries(Object.entries(this.#campos).map(([nombre, campo]) => [nombre, campo.entrada.value])),
      );
      if (campos.length) {
        this.#mostrarInvalidos(campos);
        return;
      }
      for (const nombre of Object.keys(this.#campos)) this.#marcar(nombre, false);
      await this.#funciones.llamar("registrar-participante", {
        cuerpo: { ...datos, version_terminos: AVISO_PRIVACIDAD.VERSION, acepto: true },
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
 * completo y pulsable. Completo, se queda visible el resto del video y en el bucle. Ya no abre ninguna
 * URL (enlace_url se ignora): al pulsarlo solo avisa, y el video abre su ventana simulada.
 */
class BarraDeEnlace {
  static INICIO_S = 8;
  static FIN_S = 10;
  static PATRON_COLOR = /^#[0-9A-F]{6}$/i;

  #elemento;
  #video;
  #opacidad = 0;
  #completa = false;
  #ultimoTiempo = 0;
  #cuadro = null;

  /** Devuelve la barra, o null si el video no tiene un enlace activo con texto. */
  static crear(datos, video, elemento, alPulsar) {
    if (datos?.enlace_activo !== true) return null;
    const texto = String(datos.enlace_texto ?? "").trim();
    if (!texto) return null;
    return new BarraDeEnlace(texto, datos.enlace_color, video, elemento, alPulsar);
  }

  /** El color de cada video si es #RRGGBB; si no, el color de acento de corto. */
  static colorSeguro(color) {
    if (BarraDeEnlace.PATRON_COLOR.test(color ?? "")) return color;
    return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#ff3b5c";
  }

  texto;

  constructor(texto, color, video, elemento, alPulsar) {
    this.texto = texto;
    this.#elemento = elemento;
    this.#video = video;
    elemento.querySelector("[data-enlace-texto]").textContent = texto; // nunca innerHTML
    elemento.setAttribute("aria-label", texto);
    elemento.addEventListener("click", () => { if (this.#completa) alPulsar(); });
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

/** Números al azar del navegador con crypto.getRandomValues, sin sesgo (se descartan los valores sobrantes). */
class Azar {
  static entero(minimo, maximo) {
    const rango = maximo - minimo + 1;
    const limite = Math.floor(0x1_0000_0000 / rango) * rango;
    const valor = new Uint32Array(1);
    do crypto.getRandomValues(valor); while (valor[0] >= limite);
    return minimo + (valor[0] % rango);
  }
}

/** Contadores abreviados: 999, 1.2K, 3.4M (se trunca, nunca se redondea hacia arriba). */
class FormatoContador {
  static abreviar(numero) {
    const n = Math.max(0, Math.floor(Number(numero) || 0));
    if (n < 1000) return String(n);
    const [divisor, sufijo] = n < 1e6 ? [1e3, "K"] : n < 1e9 ? [1e6, "M"] : [1e9, "B"];
    const valor = Math.floor((n * 10) / divisor) / 10;
    return `${Number.isInteger(valor) ? valor : valor.toFixed(1)}${sufijo}`;
  }
}

/**
 * Política común de reintentos: hasta 3 reintentos con espera creciente (1, 2 y 4 s), solo ante fallos
 * transitorios (red, 5xx o 429). Los rechazos definitivos (pase, registro o datos) no se reintentan.
 */
class Reintentos {
  static ESPERAS_MS = [1000, 2000, 4000];

  static reintentable(error) {
    if (error instanceof ErrorSinPase || error instanceof ErrorFaltaRegistro) return false;
    if (error instanceof ErrorDeServicio) return error.estado >= 500 || error.estado === 429;
    return true; // red
  }

  static esperar(ms) {
    return new Promise((resolver) => window.setTimeout(resolver, ms));
  }

  /** Ejecuta `tarea` con reintentos mientras `seguir()` sea true; si se agotan, lanza el último error. */
  static async ejecutar(tarea, seguir = () => true) {
    for (let intento = 0; ; intento++) {
      try {
        return await tarea();
      } catch (e) {
        if (!seguir() || !Reintentos.reintentable(e) || intento >= Reintentos.ESPERAS_MS.length) throw e;
        await Reintentos.esperar(Reintentos.ESPERAS_MS[intento]);
        if (!seguir()) throw e;
      }
    }
  }
}

/**
 * Manda las interacciones a "registrar-interaccion" sin bloquear la interfaz, con la política de
 * Reintentos; si se agotan, la descarta en silencio. Nada se guarda en el navegador.
 */
class EnviadorDeInteracciones {
  static ESPERA_MAXIMA_MS = 2500;

  #repo;
  #activo = true;
  #pendientes = new Set();

  constructor(repo) {
    this.#repo = repo;
  }

  registrar(videoId, tipo, tiempoVideoMs, extra = {}) {
    if (!this.#activo) return;
    const cuerpo = { video_id: videoId, tipo, tiempo_video_ms: tiempoVideoMs, ...extra };
    const envio = Reintentos.ejecutar(() => this.#repo.registrarInteraccion(cuerpo), () => this.#activo).catch(() => {});
    this.#pendientes.add(envio);
    envio.finally(() => this.#pendientes.delete(envio));
  }

  /**
   * Espera (hasta 2.5 s) a que lleguen las interacciones en curso: el servidor solo las acepta del video
   * actual, así que deben llegar antes de avisar que se pasó al siguiente.
   */
  async esperarPendientes() {
    if (!this.#pendientes.size) return;
    await Promise.race([Promise.allSettled([...this.#pendientes]), Reintentos.esperar(EnviadorDeInteracciones.ESPERA_MAXIMA_MS)]);
  }

  /** Al cerrarse la sesión: no se manda ni se reintenta nada más. */
  detener() {
    this.#activo = false;
  }
}

/** Acumula milisegundos de tramos abiertos y cerrados (con performance.now, inmune a cambios de hora). */
class Cronometro {
  #acumulado = 0;
  #desde = null;

  iniciar() { this.#desde ??= performance.now(); }

  parar() {
    if (this.#desde !== null) this.#acumulado += performance.now() - this.#desde;
    this.#desde = null;
  }

  get ms() { return this.#acumulado + (this.#desde === null ? 0 : performance.now() - this.#desde); }
}

/**
 * Medición de un video mientras es el actual: tiempo en pantalla (sin contar la pestaña oculta, con la
 * API de visibilidad), tiempo realmente reproduciéndose y si llegó al final al menos una vez (el video
 * se repite en bucle, así que también cuenta volver a empezar desde el final). Solo vive en memoria.
 */
class MedidorDeVisualizacion {
  static MAX_MS = 3_600_000;
  static MARGEN_FINAL_S = 0.3;

  #video;
  #escuchas = null;
  #pantalla = new Cronometro();
  #reproduccion = new Cronometro();
  #completo = false;
  #ultimoTiempo = 0;

  constructor(video) {
    this.#video = video;
  }

  iniciar() {
    if (this.#escuchas) return;
    this.#escuchas = new AbortController();
    const opciones = { signal: this.#escuchas.signal };
    const v = this.#video;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.#pantalla.iniciar();
      else this.#pantalla.parar();
    }, opciones);
    if (document.visibilityState === "visible") this.#pantalla.iniciar();
    v.addEventListener("playing", () => this.#reproduccion.iniciar(), opciones);
    for (const evento of ["pause", "waiting", "ended", "emptied", "error"]) {
      v.addEventListener(evento, () => this.#reproduccion.parar(), opciones);
    }
    v.addEventListener("ended", () => { this.#completo = true; }, opciones);
    v.addEventListener("timeupdate", () => this.#revisarFinal(), opciones);
    if (!v.paused && v.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) this.#reproduccion.iniciar();
  }

  /** Cierra la medición y devuelve { tiempo_pantalla_ms, reproduccion_ms, completo } en enteros válidos. */
  terminar() {
    this.#revisarFinal();
    this.#pantalla.parar();
    this.#reproduccion.parar();
    this.#escuchas?.abort();
    this.#escuchas = null;
    const acotar = (ms) => Math.min(MedidorDeVisualizacion.MAX_MS, Math.max(0, Math.round(ms)));
    return { tiempo_pantalla_ms: acotar(this.#pantalla.ms), reproduccion_ms: acotar(this.#reproduccion.ms), completo: this.#completo };
  }

  #revisarFinal() {
    const { duration: d, currentTime: t } = this.#video;
    if (Number.isFinite(d) && d > 0) {
      if (t >= d - MedidorDeVisualizacion.MARGEN_FINAL_S) this.#completo = true;
      else if (t + 0.5 < this.#ultimoTiempo && this.#ultimoTiempo >= d - 1) this.#completo = true; // dio la vuelta
    }
    this.#ultimoTiempo = t || 0;
  }
}

/**
 * Botón de dos estados (me gusta, guardar, seguir): aria-pressed, clase "activo" para el ícono relleno,
 * una animación breve y, si tiene contador, suma 1 solo en pantalla. El estado vive solo en memoria.
 */
class BotonInterruptor {
  #boton;
  #cuenta;
  #base;
  #textos;
  #etiquetas;
  #activo = false;

  constructor(boton, { base = null, textos = null, etiquetas = null, alCambiar }) {
    this.#boton = boton;
    this.#cuenta = base === null ? null : boton.querySelector("[data-cuenta]");
    this.#base = Math.max(0, Math.floor(Number(base) || 0));
    this.#textos = textos;
    this.#etiquetas = etiquetas;
    boton.addEventListener("click", () => {
      this.#activo = !this.#activo;
      this.#pintar();
      this.#animar();
      alCambiar(this.#activo);
    });
    boton.addEventListener("animationend", () => boton.classList.remove("latido"));
    this.#pintar();
  }

  #pintar() {
    this.#boton.setAttribute("aria-pressed", String(this.#activo));
    this.#boton.classList.toggle("activo", this.#activo);
    if (this.#cuenta) this.#cuenta.textContent = FormatoContador.abreviar(this.#base + (this.#activo ? 1 : 0));
    if (this.#textos) this.#boton.textContent = this.#textos[this.#activo ? 1 : 0];
    if (this.#etiquetas) this.#boton.setAttribute("aria-label", this.#etiquetas[this.#activo ? 1 : 0]);
  }

  #animar() {
    this.#boton.classList.remove("latido");
    void this.#boton.offsetWidth; // reinicia la animación si se pulsa seguido
    this.#boton.classList.add("latido");
  }
}

/** Capas abiertas (paneles, menús, ventanas): Esc cierra solo la de arriba. */
class PilaDeCapas {
  static #capas = [];

  static {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !PilaDeCapas.#capas.length) return;
      e.preventDefault();
      PilaDeCapas.#capas.at(-1).cerrarPorTecla();
    });
  }

  static get vacia() { return PilaDeCapas.#capas.length === 0; }

  static apilar(capa) {
    PilaDeCapas.quitar(capa);
    PilaDeCapas.#capas.push(capa);
  }

  static quitar(capa) {
    PilaDeCapas.#capas = PilaDeCapas.#capas.filter((c) => c !== capa);
  }
}

/**
 * Capa que se abre desde un botón dentro de la tarjeta del video y se cierra con su X, con Esc o con un
 * clic fuera de ella. Al cerrarse devuelve el foco al botón si lo tenía dentro.
 */
class CapaFlotante {
  #contenedor;
  #boton;
  #elemento = null;
  #escuchas = null;

  constructor(contenedor, boton) {
    this.#contenedor = contenedor;
    this.#boton = boton;
  }

  get abierta() { return this.#elemento !== null; }

  /** Lo que se muestra: un elemento nuevo con [data-cerrar] opcional y la parte "de dentro" en [data-hoja]. */
  construir() { throw new Error("construir"); }

  abrir() {
    if (this.abierta) return false;
    this.#elemento = this.construir();
    this.#escuchas = new AbortController();
    const opciones = { signal: this.#escuchas.signal };
    this.#elemento.querySelector("[data-cerrar]")?.addEventListener("click", () => this.cerrar(), opciones);
    // Clic fuera (en la tarjeta o en la página): cierra. El clic no sigue hacia el video ni hacia otros botones de la capa.
    document.addEventListener("click", (e) => {
      const dentro = this.#elemento.querySelector("[data-hoja]") ?? this.#elemento;
      if (dentro.contains(e.target) || this.#boton.contains(e.target)) return;
      if (this.#elemento.contains(e.target)) e.stopPropagation(); // el fondo de la capa no pausa el video
      this.cerrar();
    }, { ...opciones, capture: true });
    this.#contenedor.append(this.#elemento);
    this.#boton.setAttribute("aria-expanded", "true");
    PilaDeCapas.apilar(this);
    (this.#elemento.querySelector("[data-cerrar], [role=menuitem]"))?.focus({ preventScroll: true });
    return true;
  }

  cerrar() {
    if (!this.abierta) return;
    const teniaFoco = this.#elemento.contains(document.activeElement);
    this.#escuchas.abort();
    this.#elemento.remove();
    this.#elemento = null;
    this.#boton.setAttribute("aria-expanded", "false");
    PilaDeCapas.quitar(this);
    if (teniaFoco) this.#boton.focus({ preventScroll: true });
  }

  cerrarPorTecla() { this.cerrar(); }
}

/** Avatar de un comentario: su foto o, si no tiene (o no carga), un círculo con las iniciales en su color. */
class AvatarDeComentario {
  static PATRON_COLOR = /^#[0-9a-f]{6}$/i;

  /** usuario.uno → UU; ana → AN. */
  static iniciales(usuario) {
    const partes = String(usuario ?? "").replace(/^@+/, "").split(/[._]+/).filter(Boolean);
    if (!partes.length) return "?";
    const texto = partes.length >= 2 ? [...partes[0]][0] + [...partes[1]][0] : [...partes[0]].slice(0, 2).join("");
    return texto.toUpperCase();
  }

  static pintar(caja, comentario, urlFoto) {
    const ponerIniciales = () => {
      const span = document.createElement("span");
      span.textContent = AvatarDeComentario.iniciales(comentario.usuario);
      caja.style.backgroundColor = AvatarDeComentario.PATRON_COLOR.test(comentario.color ?? "") ? comentario.color : "";
      caja.replaceChildren(span);
    };
    if (!urlFoto) { ponerIniciales(); return; }
    const img = document.createElement("img");
    img.alt = "";
    img.draggable = false;
    img.src = urlFoto;
    img.addEventListener("error", ponerIniciales, { once: true });
    caja.replaceChildren(img);
  }
}

/** Fecha corta de un comentario (día-mes, p. ej., 15-10) en la zona horaria de la Ciudad de México. */
class FechaDeComentario {
  static #formato = new Intl.DateTimeFormat("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit" });

  /** Texto visible y valor ISO para <time>; null si la fecha no es válida. */
  static de(valor) {
    const fecha = new Date(valor ?? "");
    if (Number.isNaN(fecha.getTime())) return null;
    const partes = Object.fromEntries(FechaDeComentario.#formato.formatToParts(fecha).map((p) => [p.type, p.value]));
    return { texto: `${partes.day}-${partes.month}`, iso: fecha.toISOString() };
  }
}

/**
 * "Me gusta" simulado de un comentario: sale de un hash FNV-1a (32 bits) de usuario + texto, así que es el
 * mismo para todos los participantes y en cada visita. Siempre entre 3 y 4999.
 */
class MeGustaDeComentario {
  static MIN = 3;
  static MAX = 4999;

  static #fnv1a(texto) {
    let h = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(texto)) h = Math.imul(h ^ byte, 0x01000193);
    return h >>> 0;
  }

  static de(comentario) {
    const clave = `${String(comentario.usuario ?? "")}\u0000${String(comentario.texto ?? "")}`;
    const { MIN, MAX } = MeGustaDeComentario;
    return MIN + (MeGustaDeComentario.#fnv1a(clave) % (MAX - MIN + 1));
  }
}

/** Panel de comentarios de un video al estilo de una red de videos cortos, solo lectura (la barra para escribir está desactivada). */
class PanelDeComentarios extends CapaFlotante {
  static #miles = new Intl.NumberFormat("es-MX");
  #comentarios;
  #total;
  #urlImagen;

  constructor(contenedor, boton, comentarios, total, urlImagen) {
    super(contenedor, boton);
    this.#comentarios = Array.isArray(comentarios) ? comentarios : [];
    this.#total = Math.max(0, Math.floor(Number(total) || 0));
    this.#urlImagen = urlImagen;
  }

  /** "1 comentario", "1,234 comentarios". */
  static titulo(total) {
    return `${PanelDeComentarios.#miles.format(total)} ${total === 1 ? "comentario" : "comentarios"}`;
  }

  #elemento(c, plantilla) {
    const li = plantilla.cloneNode(true);
    AvatarDeComentario.pintar(li.querySelector("[data-avatar-com]"), c, this.#urlImagen(c.foto_perfil_ruta));
    li.querySelector("[data-com-usuario]").textContent = c.usuario ? `@${String(c.usuario).replace(/^@+/, "")}` : "";
    li.querySelector("[data-com-texto]").textContent = String(c.texto ?? "");
    const fecha = FechaDeComentario.de(c.creado_en);
    const time = li.querySelector("[data-com-fecha]");
    if (fecha) { time.textContent = fecha.texto; time.dateTime = fecha.iso; } else time.remove();
    li.querySelector("[data-com-me-gusta]").textContent = FormatoContador.abreviar(MeGustaDeComentario.de(c));
    return li;
  }

  construir() {
    const capa = document.getElementById("tpl-comentarios").content.firstElementChild.cloneNode(true);
    capa.querySelector("[data-titulo]").textContent = PanelDeComentarios.titulo(this.#total);
    const plantilla = document.getElementById("tpl-comentario").content.firstElementChild;
    const items = this.#comentarios.map((c) => this.#elemento(c, plantilla));
    capa.querySelector("[data-lista]").replaceChildren(...items);
    capa.querySelector("[data-lista]").hidden = !items.length;
    capa.querySelector("[data-vacio]").hidden = items.length > 0;
    return capa;
  }
}

/** Menú de "…": sus tres opciones solo cierran el menú. */
class MenuMasOpciones extends CapaFlotante {
  construir() {
    const menu = document.getElementById("tpl-menu-mas").content.firstElementChild.cloneNode(true);
    for (const opcion of menu.querySelectorAll("[role=menuitem]")) opcion.addEventListener("click", () => this.cerrar());
    menu.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      e.stopPropagation(); // no cambia de video
      const opciones = [...menu.querySelectorAll("[role=menuitem]")];
      const i = opciones.indexOf(document.activeElement);
      opciones[(i + (e.key === "ArrowDown" ? 1 : opciones.length - 1)) % opciones.length].focus();
    });
    return menu;
  }
}

/**
 * Ventana simulada de compartir o del botón de enlace, dentro de la tarjeta del video y sin pausarlo.
 * Muestra un indicador de carga de 0.5 a 1 s y luego contenido propio, genérico e inerte. Se cierra sola
 * a un tiempo al azar (crypto) sin ningún mensaje, o antes con la X o con Esc. Solo una abierta a la vez.
 */
class VentanaSimulada {
  static CARGA_MS = [500, 1000];
  // Entre 10 y 15 s; el tope deja margen para que la duración medida tampoco pase de 15 000 ms.
  static CIERRE_MS = [10_000, 14_750];
  static MAX_DURACION_MS = 60_000;
  static #abierta = null;

  #plantilla;
  #contenedor;
  #preparar;
  #alCerrar;
  #capa = null;
  #inicio = 0;
  #temporizadores = [];
  #focoPrevio = null;

  constructor(plantilla, contenedor, alCerrar, preparar = () => {}) {
    this.#plantilla = plantilla;
    this.#contenedor = contenedor;
    this.#alCerrar = alCerrar;
    this.#preparar = preparar;
  }

  static compartir(contenedor, alCerrar) {
    return new VentanaSimulada("tpl-compartir", contenedor, alCerrar);
  }

  static enlace(contenedor, texto, alCerrar) {
    return new VentanaSimulada("tpl-ventana-enlace", contenedor, alCerrar, (capa) => {
      capa.querySelector("[data-ventana-titulo]").textContent = texto; // el texto del botón, nunca la URL
      capa.querySelector("[data-hoja]").setAttribute("aria-label", texto);
    });
  }

  /** true si se abrió; false si ya hay otra ventana simulada abierta. */
  abrir() {
    if (VentanaSimulada.#abierta) return false;
    VentanaSimulada.#abierta = this;
    this.#inicio = performance.now();
    this.#focoPrevio = document.activeElement;
    this.#capa = document.getElementById(this.#plantilla).content.firstElementChild.cloneNode(true);
    this.#preparar(this.#capa);
    this.#capa.querySelector("[data-cerrar]").addEventListener("click", () => this.#cerrar("manual"));
    this.#capa.addEventListener("click", (e) => e.stopPropagation()); // nada debajo recibe el clic
    this.#contenedor.append(this.#capa);
    PilaDeCapas.apilar(this);
    this.#capa.querySelector("[data-cerrar]").focus({ preventScroll: true });
    this.#temporizadores.push(
      window.setTimeout(() => this.#mostrarContenido(), Azar.entero(...VentanaSimulada.CARGA_MS)),
      window.setTimeout(() => this.#cerrar("automatico"), Azar.entero(...VentanaSimulada.CIERRE_MS)),
    );
    return true;
  }

  cerrarPorTecla() { this.#cerrar("manual"); }

  /** Al cerrarse la sesión: se quita sin registrar nada. */
  descartar() { this.#quitar(); }

  #mostrarContenido() {
    if (!this.#capa) return;
    this.#capa.querySelector("[data-carga]").hidden = true;
    this.#capa.querySelector("[data-contenido]").hidden = false;
  }

  #cerrar(detalle) {
    if (!this.#capa) return;
    const duracion = Math.min(VentanaSimulada.MAX_DURACION_MS, Math.max(0, Math.round(performance.now() - this.#inicio)));
    const teniaFoco = this.#capa.contains(document.activeElement);
    this.#quitar();
    if (teniaFoco && this.#focoPrevio?.isConnected) this.#focoPrevio.focus({ preventScroll: true });
    this.#alCerrar(detalle, duracion);
  }

  #quitar() {
    if (!this.#capa) return;
    this.#temporizadores.forEach((t) => window.clearTimeout(t));
    this.#temporizadores = [];
    this.#capa.remove();
    this.#capa = null;
    PilaDeCapas.quitar(this);
    if (VentanaSimulada.#abierta === this) VentanaSimulada.#abierta = null;
  }
}

/**
 * Un video del feed: pide su URL firmada, la renueva al caducar, bloquea menús y descargas y mide su
 * visualización mientras es el actual.
 */
class VideoDelFeed {
  static MARGEN_MS = 20_000; // se pide una URL nueva si a la actual le quedan menos de 20 s

  #repo;
  #datos;
  #feed;
  #metricas;
  #video;
  #player;
  #barra = null;
  #comentarios;
  #menu;
  #ventana = null;
  #aviso;
  #progreso;
  #medidor;
  #firma = null;
  #pidiendo = null;
  #reintentos = 0;
  #activo = false;
  #pausadoPorUsuario = false;
  #destruido = false;
  raiz;

  constructor(repo, datos, feed, metricas) {
    this.#repo = repo;
    this.#datos = datos;
    this.#feed = feed;
    this.#metricas = metricas;
    this.raiz = document.getElementById("tpl-slide").content.firstElementChild.cloneNode(true);
    this.#video = this.raiz.querySelector("video");
    this.#player = this.raiz.querySelector(".player");
    this.#aviso = this.raiz.querySelector("[data-aviso]");
    this.#progreso = this.raiz.querySelector("[data-progreso]");
    this.#medidor = new MedidorDeVisualizacion(this.#video);
    this.#pintarDatos();
    this.#barra = BarraDeEnlace.crear(datos, this.#video, this.raiz.querySelector("[data-enlace]"), () => this.#abrirEnlace());
    this.#protegerVideo();
    this.#conectarControles();
    this.#conectarInteracciones();
  }

  get id() { return this.#datos.id; }

  /** Pasa a ser el video actual: empieza a medirse y a reproducirse. */
  async activar() {
    this.#activo = true;
    this.#pausadoPorUsuario = false;
    this.#medidor.iniciar();
    await this.#asegurarFuente();
    if (this.#activo) this.#reproducir();
  }

  desactivar() {
    this.#activo = false;
    this.#video.pause();
    this.#comentarios.cerrar();
    this.#menu.cerrar();
  }

  /** Se pasa al siguiente: cierra la medición, detiene el video y devuelve lo medido. */
  terminar() {
    const medicion = this.#medidor.terminar();
    this.desactivar();
    return medicion;
  }

  /** Precarga la URL del siguiente video para que empiece sin espera. */
  async precargar() {
    if (!this.#activo) await this.#asegurarFuente(false);
  }

  /** Al salir de pantalla o cerrarse la sesión: detiene el video, suelta su URL firmada y lo quita. */
  destruir() {
    this.#destruido = true;
    this.#medidor.terminar();
    this.#activo = false;
    this.#comentarios.cerrar();
    this.#menu.cerrar();
    this.#ventana?.descartar();
    this.#video.pause();
    this.#video.removeAttribute("src");
    this.#video.load();
    this.#firma = null;
    this.raiz.remove();
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
      if (this.#video.paused) {
        this.#pausadoPorUsuario = false;
        this.#reproducir();
        this.#registrar("reanudar");
      } else {
        this.#pausadoPorUsuario = true;
        this.#video.pause();
        this.#registrar("pausa");
      }
    };
    this.raiz.querySelector("[data-escudo]").addEventListener("click", alternar);
    this.raiz.querySelector("[data-pausa]").addEventListener("click", alternar);
    this.raiz.querySelector("[data-sonido]").addEventListener("click", () => {
      this.#feed.alternarSonido();
      this.#registrar(this.#video.muted ? "silenciar" : "activar_sonido");
    });
    this.#video.addEventListener("play", () => this.#iconoPausa(true));
    this.#video.addEventListener("pause", () => this.#iconoPausa(false));
  }

  // ------------------------------------------------------------ interacciones
  #conectarInteracciones() {
    const d = this.#datos;
    const boton = (atributo) => this.raiz.querySelector(`[${atributo}]`);
    new BotonInterruptor(boton("data-me-gusta"), {
      base: d.me_gusta_num, alCambiar: (activo) => this.#registrar(activo ? "me_gusta" : "quitar_me_gusta"),
    });
    new BotonInterruptor(boton("data-guardar"), {
      base: d.guardados_num, alCambiar: (activo) => this.#registrar(activo ? "guardar" : "quitar_guardar"),
    });
    const usuario = d.usuario ? `@${d.usuario}` : "esta cuenta";
    new BotonInterruptor(boton("data-seguir"), {
      textos: ["Seguir", "Siguiendo"],
      etiquetas: [`Seguir a ${usuario}`, `Dejar de seguir a ${usuario}`],
      alCambiar: (activo) => this.#registrar(activo ? "seguir" : "dejar_seguir"),
    });

    const botonComentarios = boton("data-comentarios");
    botonComentarios.querySelector("[data-cuenta]").textContent = FormatoContador.abreviar(d.comentarios_num);
    this.#comentarios = new PanelDeComentarios(this.#player, botonComentarios, d.comentarios, d.comentarios_num, (ruta) => this.#repo.urlImagen(ruta));
    botonComentarios.addEventListener("click", () => {
      if (this.#comentarios.abierta) { this.#comentarios.cerrar(); return; }
      if (this.#comentarios.abrir()) this.#registrar("comentarios");
    });

    const botonMas = boton("data-mas");
    this.#menu = new MenuMasOpciones(this.#player, botonMas);
    botonMas.addEventListener("click", () => {
      if (this.#menu.abierta) { this.#menu.cerrar(); return; }
      if (this.#menu.abrir()) this.#registrar("mas_opciones");
    });

    boton("data-compartir").addEventListener("click", () => {
      this.#abrirVentana(VentanaSimulada.compartir(this.#player, (detalle, duracion) =>
        this.#registrar("compartir_cerrado", { detalle, duracion_ms: duracion })), "compartir");
    });
  }

  #abrirEnlace() {
    if (!this.#barra) return;
    this.#abrirVentana(VentanaSimulada.enlace(this.#player, this.#barra.texto, (detalle, duracion) =>
      this.#registrar("ver_enlace_cerrado", { detalle, duracion_ms: duracion })), "ver_enlace");
  }

  /** Abre la ventana simulada (si no hay otra abierta) y registra la apertura. */
  #abrirVentana(ventana, tipo) {
    if (this.#destruido || !ventana.abrir()) return;
    this.#ventana = ventana;
    this.#registrar(tipo);
  }

  /** Tiempo actual del video en milisegundos enteros, dentro del rango que acepta el servidor. */
  #tiempoMs() {
    return Math.min(3_600_000, Math.max(0, Math.round((this.#video.currentTime || 0) * 1000)));
  }

  #registrar(tipo, extra) {
    if (this.#destruido) return;
    this.#metricas.registrar(this.#datos.id, tipo, this.#tiempoMs(), extra);
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

/**
 * Fase a ciegas: un video a la vez y solo hacia adelante. En el DOM solo están el video actual y el
 * siguiente (precargado y oculto); el anterior se destruye al confirmarse el paso. No hay forma de volver:
 * ni botón, ni flecha, ni gesto, ni teclado, ni rueda. Al pasar, la medición del actual se manda a
 * "registrar-visualizacion" y el siguiente se muestra cuando el servidor confirma; luego se pide a
 * "feed-videos" el que sigue. Si algo falla tras los reintentos, solo se muestra un mensaje genérico.
 */
class FeedACiegas {
  static MENSAJE_FALLO = "Algo salió mal. Recarga la página.";
  static UMBRAL_DESLIZAR_PX = 60;
  static TECLA_SIGUIENTE = "ArrowDown";
  static TECLAS_BLOQUEADAS = new Set(["ArrowUp", "PageUp", "PageDown", "Home", "End", " "]);

  #repo;
  #metricas;
  #alPerderPase;
  #alFaltarRegistro;
  #alTerminar;
  #contenedor = document.getElementById("feed");
  #estado = document.getElementById("feed-estado");
  #espera = document.getElementById("feed-espera");
  #botonSiguiente = document.getElementById("nav-siguiente");
  #actual = null;
  #siguiente = null;
  #cargaSiguiente = Promise.resolve();
  #avanzando = false;
  #terminado = false;
  #conSonido = false;
  #escuchas = new AbortController(); // permite quitar todos los escuchadores al vaciar
  #toque = null;

  constructor(repo, { alPerderPase, alFaltarRegistro, alTerminar }) {
    this.#repo = repo;
    this.#metricas = new EnviadorDeInteracciones(repo);
    this.#alPerderPase = alPerderPase;
    this.#alFaltarRegistro = alFaltarRegistro;
    this.#alTerminar = alTerminar;
  }

  /** `estado` viene de "feed-videos" en la etapa "ciega": videos = [actual, siguiente?]. */
  iniciar(estado) {
    document.addEventListener("contextmenu", (e) => {
      if (e.target.closest?.(".player, video, img")) e.preventDefault();
    }, { signal: this.#escuchas.signal });
    const [actual, siguiente] = estado.videos;
    if (!actual) { this.#fallar(); return; }
    this.#estado.remove();
    this.#actual = this.#crear(actual);
    this.#mostrar(this.#actual, false);
    if (siguiente) this.#ponerSiguiente(this.#crear(siguiente));
    this.#conectarNavegacion();
  }

  /** El servidor rechazó el pase (vencido o alterado): se detiene todo y se vuelve al acceso. */
  perderPase() {
    this.#actual?.desactivar();
    this.#alPerderPase();
  }

  /** Detiene envíos y escuchadores y destruye los videos (src y elementos). La página queda vacía. */
  vaciar() {
    this.#terminado = true;
    this.#metricas.detener();
    this.#escuchas.abort();
    this.#quitarVideos();
    this.#estado.textContent = "Cargando videos…";
    this.#estado.setAttribute("role", "status");
    this.#contenedor.replaceChildren(this.#estado);
    this.#contenedor.removeAttribute("aria-busy");
    this.#espera.hidden = true;
    this.#botonSiguiente.disabled = true;
  }

  alternarSonido() {
    this.#conSonido = !this.#conSonido;
    this.#aplicarSonido();
  }

  silenciar() {
    this.#conSonido = false;
    this.#aplicarSonido();
  }

  #aplicarSonido() {
    for (const v of [this.#actual, this.#siguiente]) v?.aplicarSonido(this.#conSonido);
  }

  #crear(datos) {
    const video = new VideoDelFeed(this.#repo, datos, this, this.#metricas);
    video.aplicarSonido(this.#conSonido);
    video.raiz.hidden = true;
    this.#contenedor.append(video.raiz);
    return video;
  }

  #mostrar(video, animar) {
    video.raiz.hidden = false;
    if (animar) {
      video.raiz.classList.add("entrando");
      video.raiz.addEventListener("animationend", () => video.raiz.classList.remove("entrando"), { once: true });
    }
    video.activar();
    this.#botonSiguiente.disabled = false;
  }

  #ponerSiguiente(video) {
    this.#siguiente = video;
    video.precargar();
  }

  #quitarVideos() {
    this.#actual?.destruir();
    this.#siguiente?.destruir();
    this.#actual = null;
    this.#siguiente = null;
  }

  /** Pide a "feed-videos" el video que sigue al actual. Si falla, el paso siguiente mostrará el error. */
  async #pedirSiguiente(idActual) {
    try {
      const estado = await Reintentos.ejecutar(() => this.#repo.estado(), () => !this.#terminado);
      if (this.#terminado) return;
      const [actual, siguiente] = estado.videos;
      if (estado.etapa !== "ciega" || actual?.id !== idActual || !siguiente) throw new Error("siguiente");
      this.#ponerSiguiente(this.#crear(siguiente));
    } catch (e) {
      if (e instanceof ErrorSinPase && !this.#terminado) this.perderPase();
    }
  }

  async #avanzar() {
    if (this.#avanzando || this.#terminado || !this.#actual || !PilaDeCapas.vacia) return;
    this.#avanzando = true;
    this.#botonSiguiente.disabled = true;
    const actual = this.#actual;
    const medicion = actual.terminar();
    this.#espera.hidden = false;
    this.#contenedor.setAttribute("aria-busy", "true");
    try {
      await this.#metricas.esperarPendientes();
      const avance = await Reintentos.ejecutar(
        () => this.#repo.registrarVisualizacion({ video_id: actual.id, ...medicion }), () => !this.#terminado);
      if (this.#terminado) return;
      if (avance.etapa !== "ciega") { this.#terminado = true; this.#alTerminar(); return; }
      await this.#cargaSiguiente;
      const siguiente = this.#siguiente;
      if (this.#terminado) return;
      if (!siguiente) throw new Error("siguiente");
      actual.destruir();
      this.#actual = siguiente;
      this.#siguiente = null;
      this.#mostrar(siguiente, true);
      this.#cargaSiguiente = avance.posicion + 1 < avance.total ? this.#pedirSiguiente(siguiente.id) : Promise.resolve();
    } catch (e) {
      if (this.#terminado) return;
      if (e instanceof ErrorSinPase) { this.perderPase(); return; }
      if (e instanceof ErrorFaltaRegistro) { this.#alFaltarRegistro(); return; }
      this.#fallar();
    } finally {
      this.#avanzando = false;
      if (!this.#terminado) {
        this.#espera.hidden = true;
        this.#contenedor.removeAttribute("aria-busy");
      }
    }
  }

  /** Error sin detalles técnicos: se quitan los videos y no se puede seguir sin recargar. */
  #fallar() {
    this.#terminado = true;
    this.#metricas.detener();
    this.#quitarVideos();
    this.#espera.hidden = true;
    this.#contenedor.removeAttribute("aria-busy");
    this.#botonSiguiente.disabled = true;
    this.#estado.textContent = FeedACiegas.MENSAJE_FALLO;
    this.#estado.setAttribute("role", "alert");
    this.#contenedor.replaceChildren(this.#estado);
  }

  /** Dentro de un panel, menú o ventana, los gestos son de esa capa (p. ej., desplazar comentarios). */
  static #enCapa(objetivo) {
    return Boolean(objetivo?.closest?.(".capa, .menu-mas"));
  }

  #conectarNavegacion() {
    const opciones = { signal: this.#escuchas.signal };
    this.#botonSiguiente.addEventListener("click", () => this.#avanzar(), opciones);

    // En PC solo la tecla ↓ avanza. La rueda, el panel táctil y Ctrl + rueda (zoom) no mueven el feed:
    // no hay escuchador de "wheel" y el feed no se desplaza por sí mismo. Nunca hay forma de regresar.
    document.addEventListener("keydown", (e) => {
      if (!PilaDeCapas.vacia || e.target.closest?.("input, textarea, select")) return;
      if (e.key === FeedACiegas.TECLA_SIGUIENTE) { e.preventDefault(); this.#avanzar(); }
      else if (FeedACiegas.TECLAS_BLOQUEADAS.has(e.key) && !e.target.closest?.("button")) e.preventDefault();
    }, opciones);

    // Deslizar hacia arriba avanza; hacia abajo no hace nada.
    this.#contenedor.addEventListener("touchstart", (e) => {
      this.#toque = e.touches.length === 1 && !FeedACiegas.#enCapa(e.target)
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { ...opciones, passive: true });
    this.#contenedor.addEventListener("touchend", (e) => {
      const inicio = this.#toque;
      this.#toque = null;
      const fin = e.changedTouches[0];
      if (!inicio || !fin) return;
      const dy = inicio.y - fin.clientY;
      if (dy >= FeedACiegas.UMBRAL_DESLIZAR_PX && dy > Math.abs(inicio.x - fin.clientX)) this.#avanzar();
    }, { ...opciones, passive: true });
    this.#contenedor.addEventListener("touchcancel", () => { this.#toque = null; }, opciones);
  }
}

/** Pantalla de un solo mensaje (con botón opcional): instrucción, revelación y fin provisional. */
class PantallaDeMensaje {
  #seccion;
  #boton;
  #error;
  #texto;

  constructor(id, { boton = null, error = null, texto = null, alPulsar = null } = {}) {
    this.#seccion = document.getElementById(id);
    this.#boton = boton ? document.getElementById(boton) : null;
    this.#error = error ? document.getElementById(error) : null;
    this.#texto = texto ? document.getElementById(texto) : null;
    this.#boton?.addEventListener("click", () => { if (!this.#boton.disabled) alPulsar?.(); });
  }

  /** Con `bloqueado`, el botón empieza desactivado (hasta llamar a desbloquear) y el foco va al texto. */
  mostrar({ bloqueado = false } = {}) {
    this.mostrarError("");
    this.ocupado(false);
    if (this.#boton) this.#boton.disabled = bloqueado;
    this.#seccion.hidden = false;
    ((bloqueado ? null : this.#boton) ?? this.#texto ?? this.#boton)?.focus();
  }

  desbloquear() {
    if (this.#boton) this.#boton.disabled = false;
  }

  ocultar() {
    this.#seccion.hidden = true;
  }

  ocupado(si) {
    if (!this.#boton) return;
    this.#boton.disabled = si;
    this.#boton.setAttribute("aria-busy", String(si));
  }

  mostrarError(texto) {
    if (!this.#error) return;
    this.#error.textContent = texto;
    this.#error.hidden = !texto;
  }
}

/**
 * Pasos 5, 6 y 8: una cuadrícula de caras o miniaturas (cada una un botón con aria-pressed) y la opción
 * "Ninguna"/"Ninguno". Un elemento sin imagen se muestra como un cuadro gris neutro, igual de seleccionable;
 * sin elementos (p. ej., ningún video con actor) solo queda "Ninguna". Elegir un elemento quita "Ninguno" y elegir "Ninguno" quita los elementos. "Aceptar"
 * se activa con al menos un elemento o "Ninguno". La selección vive solo en memoria: al aceptar se manda
 * { etapa, marcados, ninguno } con los ids que dio el servidor. Ningún texto menciona cuántos hay.
 */
class PantallaDeSeleccion {
  static TEXTOS = Object.freeze({
    conoce: Object.freeze({
      titulo: "¿Conoces a alguna de estas personas?", subtitulo: "Elige las que reconozcas.",
      ninguno: "Ninguna", elemento: "Persona", forma: "cara",
    }),
    convencio: Object.freeze({
      titulo: "Si este video te llegara a tu celular, ¿harías lo que te pide?", subtitulo: "Marca los videos en los que sí.",
      ninguno: "Ninguno", elemento: "Video", forma: "miniatura",
    }),
    memoria: Object.freeze({
      titulo: "¿Cuáles crees que eran deepfake?", subtitulo: "Marca los que sí.",
      ninguno: "Ninguno", elemento: "Video", forma: "miniatura",
    }),
  });
  static MENSAJE_FALLA = "No se pudo enviar tu respuesta. Intenta de nuevo.";

  #seccion = document.getElementById("seleccion");
  #titulo = document.getElementById("seleccion-titulo");
  #subtitulo = document.getElementById("seleccion-subtitulo");
  #rejilla = document.getElementById("seleccion-rejilla");
  #botonNinguno = document.getElementById("seleccion-ninguno");
  #textoNinguno = document.getElementById("seleccion-ninguno-texto");
  #aceptar = document.getElementById("seleccion-aceptar");
  #error = document.getElementById("seleccion-error");
  #alAceptar;
  #etapa = null;
  #botones = new Map(); // id → botón
  #marcados = new Set();
  #ninguno = false;
  #ocupado = false;

  static admite(etapa) {
    return Object.hasOwn(PantallaDeSeleccion.TEXTOS, etapa);
  }

  constructor(alAceptar) {
    this.#alAceptar = alAceptar;
    this.#botonNinguno.addEventListener("click", () => this.#elegirNinguno());
    this.#aceptar.addEventListener("click", () => this.#enviar());
  }

  /** elementos: [{ id, url }] en el orden recibido del servidor. */
  mostrar(etapa, elementos) {
    const textos = PantallaDeSeleccion.TEXTOS[etapa];
    if (!textos) throw new Error("etapa");
    this.#etapa = etapa;
    this.#marcados.clear();
    this.#ninguno = false;
    this.#ocupado = false;
    this.#botones = new Map(elementos.map(({ id, url }, i) => [id, this.#crearBoton(textos, id, url, i + 1)]));
    this.#seccion.dataset.forma = textos.forma;
    this.#titulo.textContent = textos.titulo;
    this.#subtitulo.textContent = textos.subtitulo;
    this.#textoNinguno.textContent = textos.ninguno;
    this.#botonNinguno.setAttribute("aria-label", textos.ninguno);
    this.#rejilla.replaceChildren(...this.#botones.values());
    this.#rejilla.hidden = this.#botones.size === 0;
    this.mostrarError("");
    this.#pintar();
    this.#seccion.hidden = false;
    this.#seccion.scrollTop = 0;
    this.#rejilla.scrollTop = 0;
    this.#titulo.focus();
  }

  ocultar() {
    this.#seccion.hidden = true;
    this.#rejilla.replaceChildren();
    this.#botones.clear();
    this.#marcados.clear();
    this.#etapa = null;
  }

  ocupado(si) {
    this.#ocupado = si;
    this.#aceptar.setAttribute("aria-busy", String(si));
    this.#pintar();
  }

  mostrarError(texto) {
    this.#error.textContent = texto;
    this.#error.hidden = !texto;
  }

  #crearBoton(textos, id, url, lugar) {
    const nombre = `${textos.elemento} ${lugar}`; // según el lugar en la lista, nunca un número interno
    const boton = document.createElement("button");
    boton.type = "button";
    boton.className = "opcion";
    boton.setAttribute("aria-label", nombre);
    boton.setAttribute("aria-pressed", "false");
    const imagen = url ? PantallaDeSeleccion.#imagen(url, nombre) : PantallaDeSeleccion.#cuadroGris(nombre);
    const marca = document.createElement("span");
    marca.className = "opcion-marca";
    marca.setAttribute("aria-hidden", "true");
    marca.append(PantallaDeSeleccion.#palomita());
    boton.append(imagen, marca);
    boton.addEventListener("click", () => this.#alternar(id));
    return boton;
  }

  static #imagen(url, nombre) {
    const imagen = document.createElement("img");
    imagen.alt = nombre;
    imagen.draggable = false;
    imagen.decoding = "async";
    imagen.referrerPolicy = "no-referrer";
    imagen.src = url;
    return imagen;
  }

  /** En lugar de una miniatura que no existe: cuadro gris con el mismo texto alternativo. */
  static #cuadroGris(nombre) {
    const cuadro = document.createElement("span");
    cuadro.className = "opcion-sin-imagen";
    cuadro.setAttribute("role", "img");
    cuadro.setAttribute("aria-label", nombre);
    return cuadro;
  }

  static #palomita() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const trazo = document.createElementNS("http://www.w3.org/2000/svg", "path");
    trazo.setAttribute("d", "M5 12.5l4.5 4.5L19 7.5");
    svg.append(trazo);
    return svg;
  }

  #alternar(id) {
    if (this.#ocupado || !this.#botones.has(id)) return;
    if (this.#marcados.has(id)) this.#marcados.delete(id);
    else this.#marcados.add(id);
    this.#ninguno = false;
    this.mostrarError("");
    this.#pintar();
  }

  #elegirNinguno() {
    if (this.#ocupado) return;
    this.#ninguno = !this.#ninguno;
    if (this.#ninguno) this.#marcados.clear();
    this.mostrarError("");
    this.#pintar();
  }

  #valida() {
    return this.#ninguno ? this.#marcados.size === 0 : this.#marcados.size > 0;
  }

  #pintar() {
    for (const [id, boton] of this.#botones) {
      const marcado = this.#marcados.has(id);
      boton.setAttribute("aria-pressed", String(marcado));
      boton.disabled = this.#ocupado;
    }
    this.#botonNinguno.setAttribute("aria-pressed", String(this.#ninguno));
    this.#botonNinguno.disabled = this.#ocupado;
    this.#aceptar.disabled = this.#ocupado || !this.#valida();
  }

  #enviar() {
    if (this.#ocupado || !this.#etapa || !this.#valida()) return;
    this.#alAceptar({ etapa: this.#etapa, marcados: [...this.#marcados], ninguno: this.#ninguno });
  }
}

/**
 * Paso 7: la revelación. "De acuerdo" empieza desactivado y se activa tras un tiempo al azar entre 10 y 15 s
 * (crypto.getRandomValues) contado desde que el participante entró a la etapa: si recarga, se descuentan los
 * segundos que ya pasaron según el servidor. El servidor rechaza por su cuenta una confirmación antes de 10 s.
 */
class PantallaDeRevelacion {
  static MIN_MS = 10_000;
  static MAX_MS = 15_000;

  #mensaje;
  #temporizador = null;

  constructor(alPulsar) {
    this.#mensaje = new PantallaDeMensaje("revelacion", {
      boton: "revelacion-aceptar", error: "revelacion-error", texto: "revelacion-texto", alPulsar,
    });
  }

  mostrar(segundosTranscurridos) {
    window.clearTimeout(this.#temporizador);
    const espera = Math.max(0, Azar.entero(PantallaDeRevelacion.MIN_MS, PantallaDeRevelacion.MAX_MS) - segundosTranscurridos * 1000);
    this.#mensaje.mostrar({ bloqueado: true });
    this.#temporizador = window.setTimeout(() => this.#mensaje.desbloquear(), espera);
  }

  ocultar() {
    window.clearTimeout(this.#temporizador);
    this.#temporizador = null;
    this.#mensaje.ocultar();
  }

  ocupado(si) { this.#mensaje.ocupado(si); }

  mostrarError(texto) { this.#mensaje.mostrarError(texto); }
}

/**
 * Arranque y flujo: código → aviso y datos → (etapa que diga el servidor) instrucción → fase a ciegas →
 * reconocimiento → "¿harías lo que te pide?" → revelación → "¿cuáles eran deepfake?" → pantalla provisional.
 * Una sola pantalla a la vez y sin forma de regresar. Sin pase solo existe la pantalla de acceso; con pase,
 * el vigilante revisa la sesión todo el tiempo. La etapa nunca se guarda en el navegador: siempre se
 * pregunta a "feed-videos" (y su contenido a "contenido-etapa"), así que al recargar sigue donde iba.
 */
class AppFeed {
  static AVISO_SESION_CERRADA = "Tu sesión se cerró";
  static MENSAJE_FALLO = "Algo salió mal. Recarga la página.";
  static MENSAJE_COMENZAR = "No se pudo continuar. Intenta de nuevo.";
  static ETAPAS_CON_CONTENIDO = new Set(["conoce", "convencio", "revelacion", "memoria"]);
  static PANTALLAS_FEED = ["cabecera", "nav", "feed"];

  #funciones;
  #almacen = new AlmacenDePase();
  #acceso;
  #registro;
  #instruccion;
  #seleccion;
  #revelacion;
  #finParte;
  #pase = null;
  #repo = null;
  #pagina = null;
  #vigilante = null;
  #comenzando = false;
  #respondiendo = false;

  constructor(config) {
    this.#funciones = new ClienteFunciones(config);
    this.#acceso = new PantallaDeAcceso(this.#funciones, (pase) => this.#entrar(pase));
    this.#registro = new PantallaDeRegistro(this.#funciones, () => this.#continuar(), () => this.#cerrarSesion());
    this.#instruccion = new PantallaDeMensaje("instruccion", {
      boton: "instruccion-comenzar", error: "instruccion-error", alPulsar: () => this.#comenzar(),
    });
    this.#seleccion = new PantallaDeSeleccion((cuerpo) => this.#responder(this.#seleccion, cuerpo));
    this.#revelacion = new PantallaDeRevelacion(() => this.#responder(this.#revelacion, { etapa: "revelacion" }));
    this.#finParte = new PantallaDeMensaje("fin-parte", { texto: "fin-parte-texto" });
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

  /** Recarga con un pase guardado: el servidor dice si falta el registro o en qué etapa va. */
  async #reanudar(pase) {
    this.#abrirSesion(pase);
    try {
      const { registrada } = await VigilanteDeSesion.estado(this.#funciones, pase);
      if (this.#pase !== pase) return;
      if (registrada) this.#continuar();
      else this.#registro.mostrar(pase);
    } catch (e) {
      if (this.#pase !== pase) return;
      if (e instanceof ErrorSinPase) this.#cerrarSesion();
      else this.#continuar(); // red o servidor: feed-videos lo intenta y, si falta el registro, regresa a él
    }
  }

  #abrirSesion(pase) {
    this.#pase = pase;
    this.#repo = new FeedRepositorio(this.#funciones, pase);
    this.#vigilante = new VigilanteDeSesion(this.#funciones, pase, () => this.#cerrarSesion());
    this.#vigilante.iniciar();
  }

  /** Pregunta la etapa al servidor y muestra la pantalla que corresponde. */
  async #continuar() {
    const pase = this.#pase;
    if (!pase) return;
    this.#registro.ocultar();
    let estado;
    try {
      estado = await this.#repo.estado();
    } catch (e) {
      if (this.#pase !== pase) return;
      if (e instanceof ErrorSinPase) this.#cerrarSesion();
      else if (e instanceof ErrorFaltaRegistro) this.#volverARegistro();
      else this.#mostrarFallo();
      return;
    }
    if (this.#pase !== pase) return;
    if (estado.etapa === "instruccion") this.#instruccion.mostrar();
    else if (estado.etapa === "ciega") this.#mostrarFeed(estado);
    else if (AppFeed.ETAPAS_CON_CONTENIDO.has(estado.etapa)) this.#mostrarContenido();
    else this.#mostrarFinParte();
  }

  /** Pide a "contenido-etapa" lo de la etapa actual y muestra su pantalla (el servidor manda la etapa). */
  async #mostrarContenido() {
    const pase = this.#pase;
    if (!pase) return;
    let contenido;
    try {
      contenido = await Reintentos.ejecutar(() => this.#repo.contenidoEtapa(), () => this.#pase === pase);
    } catch (e) {
      if (this.#pase !== pase) return;
      if (e instanceof ErrorSinPase) this.#cerrarSesion();
      else if (e instanceof ErrorFaltaRegistro) this.#volverARegistro();
      else this.#mostrarFallo();
      return;
    }
    if (this.#pase !== pase) return;
    const { etapa } = contenido;
    if (etapa === "instruccion" || etapa === "ciega") { this.#ocultarPantallas(); this.#continuar(); return; }
    this.#ocultarPantallas();
    if (PantallaDeSeleccion.admite(etapa)) this.#seleccion.mostrar(etapa, contenido.elementos);
    else if (etapa === "revelacion") this.#revelacion.mostrar(contenido.segundos);
    else this.#finParte.mostrar();
  }

  /** "Aceptar" o "De acuerdo": manda la respuesta y pasa a la etapa que confirme el servidor. */
  async #responder(pantalla, cuerpo) {
    const pase = this.#pase;
    if (!pase || this.#respondiendo) return;
    this.#respondiendo = true;
    pantalla.ocupado(true);
    pantalla.mostrarError("");
    let nueva = null;
    try {
      nueva = await this.#repo.responderEtapa(cuerpo);
    } catch (e) {
      if (this.#pase !== pase) return;
      if (e instanceof ErrorSinPase) { this.#cerrarSesion(); return; }
      if (e instanceof ErrorFaltaRegistro) { this.#volverARegistro(); return; }
      if (!(e instanceof ErrorDeServicio && e.estado === 400)) {
        pantalla.mostrarError(PantallaDeSeleccion.MENSAJE_FALLA);
        pantalla.ocupado(false);
        return;
      }
      // 400: la respuesta ya no corresponde (p. ej., otra pestaña avanzó); el servidor dice dónde va.
    } finally {
      this.#respondiendo = false;
    }
    if (this.#pase !== pase) return;
    if (nueva && !AppFeed.ETAPAS_CON_CONTENIDO.has(nueva)) { this.#ocultarPantallas(); this.#finParte.mostrar(); }
    else if (nueva) this.#mostrarContenido();
    else { this.#ocultarPantallas(); this.#continuar(); }
  }

  /** "Comenzar": de la instrucción a la fase a ciegas. Ante un rechazo, el servidor decide la etapa. */
  async #comenzar() {
    const pase = this.#pase;
    if (!pase || this.#comenzando) return;
    this.#comenzando = true;
    this.#instruccion.ocupado(true);
    this.#instruccion.mostrarError("");
    try {
      await this.#repo.comenzar();
    } catch (e) {
      if (this.#pase !== pase) return;
      if (e instanceof ErrorSinPase) { this.#cerrarSesion(); return; }
      if (e instanceof ErrorFaltaRegistro) { this.#volverARegistro(); return; }
      if (!(e instanceof ErrorDeServicio && e.estado === 400)) {
        this.#instruccion.mostrarError(AppFeed.MENSAJE_COMENZAR);
        this.#instruccion.ocupado(false);
        return;
      }
    } finally {
      this.#comenzando = false;
    }
    if (this.#pase !== pase) return;
    this.#instruccion.ocultar();
    this.#continuar();
  }

  #mostrarFeed(estado) {
    if (!this.#pase || this.#pagina) return;
    this.#instruccion.ocultar();
    for (const id of AppFeed.PANTALLAS_FEED) document.getElementById(id).hidden = false;
    this.#pagina = new FeedACiegas(this.#repo, {
      alPerderPase: () => this.#cerrarSesion(),
      alFaltarRegistro: () => this.#volverARegistro(),
      alTerminar: () => { this.#ocultarPantallas(); this.#mostrarContenido(); },
    });
    this.#pagina.iniciar(estado);
  }

  /** Pantalla provisional: se reemplazará por la siguiente etapa en la próxima entrega. */
  #mostrarFinParte() {
    this.#ocultarPantallas();
    this.#finParte.mostrar();
  }

  /** Una sola pantalla a la vez: quita el feed y oculta todas las demás. */
  #ocultarPantallas() {
    this.#quitarFeed();
    this.#instruccion.ocultar();
    this.#seleccion.ocultar();
    this.#revelacion.ocultar();
    this.#finParte.ocultar();
  }

  /** Error genérico (sin detalles técnicos) cuando no se pudo saber la etapa. */
  #mostrarFallo() {
    this.#ocultarPantallas();
    const estado = document.getElementById("feed-estado");
    estado.textContent = AppFeed.MENSAJE_FALLO;
    estado.setAttribute("role", "alert");
    document.getElementById("cabecera").hidden = false;
    document.getElementById("feed").hidden = false;
  }

  /** El servidor dice que la sesión aún no se registra: se quita el feed y se muestra el registro. */
  #volverARegistro() {
    if (!this.#pase) return;
    this.#ocultarPantallas();
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
    this.#repo = null;
    this.#almacen.borrar();
    this.#vigilante?.detener();
    this.#vigilante = null;
    this.#ocultarPantallas();
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
