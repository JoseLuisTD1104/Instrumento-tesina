"use strict";

/**
 * Ventanas de 5 minutos alineadas al reloj (:00, :05, :10…). Se calculan sobre la hora Unix:
 * como todas las zonas horarias se desplazan en múltiplos de 15 minutos, también quedan
 * alineadas a la hora local.
 */
class VentanaDeTiempo {
  static DURACION_MS = 5 * 60_000;

  constructor(indice) {
    this.indice = indice;
    this.inicio = indice * VentanaDeTiempo.DURACION_MS;
    this.fin = this.inicio + VentanaDeTiempo.DURACION_MS;
  }

  static actual(ahora = Date.now()) {
    return new VentanaDeTiempo(Math.floor(ahora / VentanaDeTiempo.DURACION_MS));
  }

  restanteMs(ahora = Date.now()) {
    return Math.min(VentanaDeTiempo.DURACION_MS, Math.max(0, this.fin - ahora));
  }
}

/**
 * Entrega el código de 6 dígitos de una ventana. En este paso lo genera en el navegador con
 * crypto.getRandomValues; en el siguiente se reemplaza por uno que lo pida a Supabase con el
 * mismo método codigoPara(ventana), sin tocar la pantalla.
 * Guarda el código de la ventana en sessionStorage para que recargar la página no lo cambie.
 */
class ProveedorDeCodigo {
  static CLAVE = "corto_codigo_ventana";
  static LIMITE = 4_294_000_000; // múltiplo de 1 000 000 menor que 2^32: evita el sesgo del módulo

  async codigoPara(ventana) {
    const guardado = this.#leerGuardado();
    if (guardado?.indice === ventana.indice) return guardado.codigo;
    const codigo = ProveedorDeCodigo.#aleatorio();
    try {
      window.sessionStorage.setItem(ProveedorDeCodigo.CLAVE, JSON.stringify({ indice: ventana.indice, codigo }));
    } catch {
      // Sin sessionStorage el código sigue sirviendo; solo cambiaría al recargar.
    }
    return codigo;
  }

  static #aleatorio() {
    const caja = new Uint32Array(1);
    do {
      crypto.getRandomValues(caja);
    } while (caja[0] >= ProveedorDeCodigo.LIMITE);
    return String(caja[0] % 1_000_000).padStart(6, "0");
  }

  #leerGuardado() {
    try {
      const datos = JSON.parse(window.sessionStorage.getItem(ProveedorDeCodigo.CLAVE) ?? "null");
      return Number.isInteger(datos?.indice) && /^\d{6}$/.test(datos?.codigo ?? "") ? datos : null;
    } catch {
      return null;
    }
  }
}

/** Pantalla de la pestaña Autenticación: código grande, círculo de tiempo, mm:ss y pantalla completa. */
class PestanaAutenticacion {
  static REFRESCO_MS = 250;
  static TRANSICION_MS = 350;

  #proveedor;
  #ventana = null;
  #intervalo = null;
  #pidiendo = false;

  #escenario = document.getElementById("auth-escenario");
  #codigo = document.getElementById("auth-codigo");
  #grupos = [document.getElementById("auth-grupo-1"), document.getElementById("auth-grupo-2")];
  #arco = document.getElementById("auth-arco");
  #tiempo = document.getElementById("auth-tiempo");
  #botonPantalla = document.getElementById("auth-pantalla-completa");
  #mensaje = document.getElementById("auth-mensaje");
  #longitudArco;

  constructor(proveedor) {
    this.#proveedor = proveedor;
    this.#longitudArco = 2 * Math.PI * Number(this.#arco.getAttribute("r")); // circunferencia del arco
    this.#arco.style.strokeDasharray = String(this.#longitudArco);
  }

  iniciar() {
    if (!this.#escenario.requestFullscreen) {
      this.#botonPantalla.disabled = true;
      this.#botonPantalla.title = "Este navegador no permite pantalla completa.";
    }
    this.#botonPantalla.addEventListener("click", () => this.#entrarPantallaCompleta());
  }

  /** Al entrar a la pestaña: empieza a contar (solo mientras se ve, para no gastar recursos). */
  mostrar() {
    if (this.#intervalo !== null) return;
    this.#actualizar();
    this.#intervalo = window.setInterval(() => this.#actualizar(), PestanaAutenticacion.REFRESCO_MS);
  }

  ocultar() {
    window.clearInterval(this.#intervalo);
    this.#intervalo = null;
    if (document.fullscreenElement === this.#escenario) document.exitFullscreen().catch(() => {});
  }

  async #actualizar() {
    const ahora = Date.now();
    const ventana = VentanaDeTiempo.actual(ahora);
    this.#pintarTiempo(ventana.restanteMs(ahora));
    if (this.#ventana?.indice !== ventana.indice && !this.#pidiendo) await this.#cambiarCodigo(ventana);
  }

  async #cambiarCodigo(ventana) {
    this.#pidiendo = true;
    const primero = this.#ventana === null;
    try {
      const codigo = await this.#proveedor.codigoPara(ventana);
      if (!/^\d{6}$/.test(codigo)) throw new Error("código inválido");
      if (!primero) {
        this.#codigo.classList.add("cambiando");
        await new Promise((r) => window.setTimeout(r, PestanaAutenticacion.TRANSICION_MS));
      }
      this.#grupos[0].textContent = codigo.slice(0, 3);
      this.#grupos[1].textContent = codigo.slice(3);
      this.#codigo.setAttribute("aria-label", `Código ${codigo.slice(0, 3)} ${codigo.slice(3)}`);
      this.#ventana = ventana;
      PanelFormato.mensaje(this.#mensaje, "");
    } catch {
      PanelFormato.mensaje(this.#mensaje, "No se pudo generar el código. Se intentará de nuevo en un momento.", "error");
    } finally {
      this.#codigo.classList.remove("cambiando");
      this.#pidiendo = false;
    }
  }

  /** El círculo y el mm:ss salen del mismo valor, así bajan en sincronía. */
  #pintarTiempo(restanteMs) {
    const fraccion = restanteMs / VentanaDeTiempo.DURACION_MS;
    this.#arco.style.strokeDashoffset = String(this.#longitudArco * (1 - fraccion));
    const segundos = Math.ceil(restanteMs / 1000);
    const mm = String(Math.floor(segundos / 60)).padStart(2, "0");
    const ss = String(segundos % 60).padStart(2, "0");
    this.#tiempo.textContent = `${mm}:${ss}`;
  }

  async #entrarPantallaCompleta() {
    try {
      await this.#escenario.requestFullscreen({ navigationUI: "hide" });
    } catch {
      PanelFormato.mensaje(this.#mensaje, "El navegador no permitió la pantalla completa.", "error");
    }
  }
}
