"use strict";

/**
 * Feed público de "corto". Solo muestra videos publicados, en cola por publicado_en.
 * Los videos están en un bucket privado: cada uno se pide a la Edge Function "video-firmado",
 * que devuelve una URL firmada de pocos minutos. Todo texto se pinta con textContent.
 */

class FeedRepositorio {
  static COLUMNAS = "id,descripcion,usuario,foto_perfil_ruta,sonido_nombre,sonido_autor,portada_sonido_ruta,publicado_en";
  static RUTA_IMAGEN = /^(perfiles|portadas)\/[0-9a-f-]{36}\.(png|jpg|webp)$/;

  #sb;
  #origen;
  #clave;

  constructor(config, libreria) {
    this.#origen = new URL(config.SUPABASE_URL).origin;
    this.#clave = config.SUPABASE_PUBLISHABLE_KEY;
    // Sin sesión: el feed es anónimo y no guarda nada en el navegador.
    this.#sb = libreria.createClient(this.#origen, this.#clave, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  /** Solo publicados, del más antiguo al más reciente: cada video nuevo queda al final. */
  async listarPublicados() {
    const { data, error } = await this.#sb.from("videos").select(FeedRepositorio.COLUMNAS)
      .eq("publicado", true)
      .order("publicado_en", { ascending: true })
      .order("id", { ascending: true });
    if (error) throw new Error("lista");
    return data ?? [];
  }

  urlImagen(ruta) {
    if (!ruta || !FeedRepositorio.RUTA_IMAGEN.test(ruta)) return null;
    return `${this.#origen}/storage/v1/object/public/imagenes/${ruta}`;
  }

  /** { url, venceEn } con la URL firmada que entrega la Edge Function. */
  async urlVideo(id) {
    const r = await fetch(`${this.#origen}/functions/v1/video-firmado`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: this.#clave },
      body: JSON.stringify({ id }),
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    if (!r.ok) throw new Error("firma");
    const datos = await r.json();
    if (typeof datos?.url !== "string" || !datos.url.startsWith(`${this.#origen}/storage/v1/object/sign/videos/`)) {
      throw new Error("firma");
    }
    const segundos = Number(datos.expira_en) > 0 ? Number(datos.expira_en) : 60;
    return { url: datos.url, venceEn: Date.now() + segundos * 1000 };
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
        this.#video.preload = "auto";
        this.#video.src = this.#firma.url; // solo en el atributo src del reproductor, nunca en texto ni enlaces
        if (segundo > 0) {
          this.#video.addEventListener("loadedmetadata", () => { this.#video.currentTime = segundo; }, { once: true });
        }
        this.#aviso.hidden = true;
      } catch {
        this.#firma = null;
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
  #contenedor = document.getElementById("feed");
  #estado = document.getElementById("feed-estado");
  #anterior = document.getElementById("nav-anterior");
  #siguiente = document.getElementById("nav-siguiente");
  #videos = [];
  #indice = -1;
  #conSonido = false;

  constructor(repo) {
    this.#repo = repo;
  }

  async iniciar() {
    // Bloqueo general de arrastre y del menú contextual sobre medios.
    document.addEventListener("contextmenu", (e) => {
      if (e.target.closest?.(".player, video, img")) e.preventDefault();
    });
    let filas;
    try {
      filas = await this.#repo.listarPublicados();
    } catch {
      this.#mostrarEstado("No se pudieron cargar los videos. Recarga la página.");
      return;
    }
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
    const observador = new IntersectionObserver((entradas) => {
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
    this.#anterior.addEventListener("click", () => this.#irA(this.#indice - 1));
    this.#siguiente.addEventListener("click", () => this.#irA(this.#indice + 1));
    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); this.#irA(this.#indice + 1); }
      if (e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); this.#irA(this.#indice - 1); }
    });
  }

  #mostrarEstado(texto) {
    this.#estado.textContent = texto;
  }
}

(() => {
  if (window.top !== window.self) { document.documentElement.textContent = ""; return; }
  const estado = document.getElementById("feed-estado");
  try {
    const config = window.CORTO_CONFIG;
    if (!config?.SUPABASE_URL || !window.supabase?.createClient) throw new Error("config");
    new FeedPagina(new FeedRepositorio(config, window.supabase)).iniciar();
  } catch {
    estado.textContent = "No se pudo cargar el feed. Recarga la página.";
  }
})();
