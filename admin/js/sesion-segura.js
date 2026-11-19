"use strict";

/** Cuenta las subidas de archivos en curso: mientras haya alguna, no hay inactividad. */
class MonitorDeSubidas {
  #activas = 0;
  #alTerminar = () => {};

  get enCurso() { return this.#activas > 0; }

  alTerminar(callback) { this.#alTerminar = callback; }

  /** Ejecuta la subida marcándola como en curso, termine bien o mal. */
  async envolver(tarea) {
    this.#activas++;
    try {
      return await tarea();
    } finally {
      this.#activas--;
      this.#alTerminar();
    }
  }
}

/** Aviso "Tu sesión se cerrará en 1 minuto" con el botón "Seguir conectado". */
class AvisoDeSesion {
  #dialogo;
  #alSeguir = () => {};

  constructor(dialogo) {
    this.#dialogo = dialogo;
    dialogo.querySelector("[data-seguir]").addEventListener("click", () => this.#seguir());
    // Escape también confirma que la persona sigue frente al equipo.
    dialogo.addEventListener("cancel", (e) => { e.preventDefault(); this.#seguir(); });
  }

  get visible() { return this.#dialogo.open; }

  alSeguirConectado(callback) { this.#alSeguir = callback; }

  mostrar() { if (!this.#dialogo.open) this.#dialogo.showModal(); }

  ocultar() { if (this.#dialogo.open) this.#dialogo.close(); }

  #seguir() {
    this.ocultar();
    this.#alSeguir();
  }
}

/**
 * Cierra la sesión del administrador:
 * - tras 15 minutos sin actividad (aviso a los 14); una subida en curso cuenta como actividad;
 * - siempre a las 4 horas desde el inicio de sesión, aunque haya actividad.
 * Usa marcas de tiempo, no temporizadores acumulados, para que funcione aunque la pestaña se suspenda.
 */
class GuardiaDeSesion {
  static INACTIVIDAD_MS = 15 * 60_000;
  static AVISO_MS = 14 * 60_000;
  static REVISION_MS = 1000;
  static EVENTOS_ACTIVIDAD = Object.freeze(["pointerdown", "pointermove", "keydown", "touchstart", "wheel", "scroll"]);
  static DESTINO_CIERRE = "./?motivo=seguridad";

  #auth;
  #subidas;
  #aviso;
  #ultimaActividad = Date.now();
  #intervalo = null;
  #cerrando = false;

  constructor(auth, subidas, aviso) {
    this.#auth = auth;
    this.#subidas = subidas;
    this.#aviso = aviso;
    subidas.alTerminar(() => this.#registrarActividad(true));
    aviso.alSeguirConectado(() => this.#registrarActividad(true));
  }

  get cerrando() { return this.#cerrando; }

  iniciar() {
    const alActuar = () => this.#registrarActividad();
    // En captura sobre window para recibir también el scroll de las columnas internas.
    for (const evento of GuardiaDeSesion.EVENTOS_ACTIVIDAD) {
      window.addEventListener(evento, alActuar, { passive: true, capture: true });
    }
    document.addEventListener("visibilitychange", () => this.#revisar());
    this.#intervalo = window.setInterval(() => this.#revisar(), GuardiaDeSesion.REVISION_MS);
    this.#revisar();
  }

  /** Cierre único para todos los casos: manual, por inactividad o por tope. */
  async cerrar() {
    if (this.#cerrando) return;
    this.#cerrando = true;
    window.clearInterval(this.#intervalo);
    this.#aviso.ocultar();
    await this.#auth.cerrarSesion();
    window.location.replace(GuardiaDeSesion.DESTINO_CIERRE);
  }

  /** Con el aviso visible, solo "Seguir conectado" (o una subida que termina) reinicia el contador. */
  #registrarActividad(forzar = false) {
    if (this.#cerrando || (this.#aviso.visible && !forzar)) return;
    this.#ultimaActividad = Date.now();
  }

  #revisar() {
    if (this.#cerrando) return;
    const ahora = Date.now();
    if (this.#auth.sesionExcedioTope(ahora)) {
      this.cerrar();
      return;
    }
    if (this.#subidas.enCurso) {
      this.#ultimaActividad = ahora;
      this.#aviso.ocultar();
      return;
    }
    const inactivo = ahora - this.#ultimaActividad;
    if (inactivo >= GuardiaDeSesion.INACTIVIDAD_MS) this.cerrar();
    else if (inactivo >= GuardiaDeSesion.AVISO_MS) this.#aviso.mostrar();
  }
}
