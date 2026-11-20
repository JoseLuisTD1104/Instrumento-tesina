"use strict";

/** Sesiones de participantes en el servidor (acciones de "codigo-actual"). Nunca recibe el jti. */
class RepositorioDeSesiones {
  #servidor;

  constructor(clienteCodigoActual) {
    this.#servidor = clienteCodigoActual;
  }

  /** [{ numero, nombre }] de las sesiones no revocadas ni vencidas, por número. */
  async listar() {
    const data = await this.#servidor.invocar({ accion: "listar_sesiones" });
    if (!Array.isArray(data?.sesiones)) throw new ErrorPanel("El servidor devolvió una respuesta inesperada.");
    return data.sesiones
      .filter((s) => Number.isSafeInteger(s?.numero) && s.numero > 0)
      .map((s) => ({ numero: s.numero, nombre: typeof s.nombre === "string" && s.nombre.trim() ? s.nombre : null }));
  }

  async cerrar(numero) {
    await this.#servidor.invocar({ accion: "cerrar_sesion", numero });
  }
}

/** Formato del número y filtro del buscador (número o nombre, sin mayúsculas ni acentos). */
class BuscadorDeSesiones {
  static formatear(numero) {
    return `#${String(numero).padStart(4, "0")}`;
  }

  static normalizar(texto) {
    return String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  static filtrar(sesiones, consulta) {
    const q = BuscadorDeSesiones.normalizar(consulta);
    if (!q) return sesiones;
    const sinAlmohadilla = q.replace(/^#/, "");
    return sesiones.filter((s) => {
      const formato = BuscadorDeSesiones.formatear(s.numero).toLowerCase(); // #0042
      return formato.includes(q) || formato.slice(1).includes(sinAlmohadilla) || String(s.numero).includes(sinAlmohadilla) ||
        BuscadorDeSesiones.normalizar(s.nombre).includes(q);
    });
  }
}

/**
 * Ventana modal "Sesiones activas": total, buscador, lista con scroll y "Cerrar sesión" por fila.
 * Usa <dialog> con showModal(): el foco queda dentro y el resto del panel queda inerte. Se cierra con
 * la X, con Esc y con clic fuera. Mientras está abierta se refresca cada 10 s sin perder el buscador
 * ni el scroll. Todo texto se pinta con textContent.
 */
class VentanaSesionesActivas {
  static REFRESCO_MS = 10_000;
  static AVISO_MS = 3000;

  #repo;
  #sesiones = [];
  #cerrando = new Set();      // números con una llamada a cerrar_sesion en curso
  #intervalo = null;
  #temporizadorAviso = null;
  #cargando = false;

  #dialogo = document.getElementById("dialogo-sesiones");
  #total = document.getElementById("sesiones-total");
  #buscador = document.getElementById("sesiones-buscador");
  #lista = document.getElementById("sesiones-lista");
  #vacio = document.getElementById("sesiones-vacio");
  #aviso = document.getElementById("sesiones-aviso");
  #plantilla = document.getElementById("tpl-sesion");

  constructor(repo) {
    this.#repo = repo;
  }

  iniciar(boton) {
    boton.addEventListener("click", () => this.abrir());
    this.#dialogo.querySelector("[data-cerrar-ventana]").addEventListener("click", () => this.#dialogo.close());
    // Clic fuera: el clic cae sobre el propio <dialog> (su fondo), no sobre su contenido.
    this.#dialogo.addEventListener("click", (e) => { if (e.target === this.#dialogo) this.#dialogo.close(); });
    // Esc siempre cierra (aunque el foco esté en el buscador con texto).
    this.#dialogo.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); this.#dialogo.close(); } });
    this.#dialogo.addEventListener("close", () => this.#alCerrar());
    this.#buscador.addEventListener("input", () => this.#pintar());
  }

  async abrir() {
    if (this.#dialogo.open) return;
    this.#buscador.value = "";
    this.#sesiones = [];
    this.#lista.replaceChildren();
    this.#mostrarVacio("Cargando sesiones…");
    this.#total.textContent = "";
    this.#mostrarAviso("");
    this.#dialogo.showModal();
    this.#buscador.focus();
    await this.#cargar();
    this.#intervalo = window.setInterval(() => this.#cargar(), VentanaSesionesActivas.REFRESCO_MS);
  }

  #alCerrar() {
    window.clearInterval(this.#intervalo);
    this.#intervalo = null;
  }

  async #cargar() {
    if (this.#cargando) return;
    this.#cargando = true;
    try {
      this.#sesiones = await this.#repo.listar();
      this.#pintar();
    } catch (e) {
      this.#mostrarAviso(PanelFormato.errorVisible(e, "No se pudo cargar la lista de sesiones."), "error");
      if (!this.#sesiones.length) this.#mostrarVacio("No se pudo cargar la lista.");
    } finally {
      this.#cargando = false;
    }
  }

  /** Repinta conservando la posición del scroll (el texto del buscador no se toca). */
  #pintar() {
    const scroll = this.#lista.scrollTop;
    const total = this.#sesiones.length;
    this.#total.textContent = total === 1 ? "1 sesión" : `${total} sesiones`;
    const visibles = BuscadorDeSesiones.filtrar(this.#sesiones, this.#buscador.value);
    this.#lista.replaceChildren(...visibles.map((s) => this.#fila(s)));
    if (!total) this.#mostrarVacio("No hay sesiones activas");
    else if (!visibles.length) this.#mostrarVacio("Sin resultados");
    else this.#mostrarVacio("");
    this.#lista.scrollTop = scroll;
  }

  #fila(sesion) {
    const fila = this.#plantilla.content.firstElementChild.cloneNode(true);
    const etiqueta = BuscadorDeSesiones.formatear(sesion.numero);
    fila.querySelector("[data-numero]").textContent = etiqueta;
    const nombre = fila.querySelector("[data-nombre]");
    nombre.textContent = sesion.nombre ?? "Sin nombre";
    nombre.classList.toggle("sin-nombre", sesion.nombre === null);
    const boton = fila.querySelector("[data-cerrar-sesion]");
    boton.setAttribute("aria-label", `Cerrar sesión ${etiqueta}`);
    boton.disabled = this.#cerrando.has(sesion.numero);
    boton.addEventListener("click", () => this.#cerrarSesion(sesion.numero, boton));
    return fila;
  }

  /** Sin confirmación: revoca, quita la fila y avisa. El botón queda deshabilitado mientras tanto. */
  async #cerrarSesion(numero, boton) {
    if (this.#cerrando.has(numero)) return;
    this.#cerrando.add(numero);
    boton.disabled = true;
    try {
      await this.#repo.cerrar(numero);
      this.#sesiones = this.#sesiones.filter((s) => s.numero !== numero);
      this.#mostrarAviso(`Sesión ${BuscadorDeSesiones.formatear(numero)} cerrada`, "exito");
    } catch (e) {
      this.#mostrarAviso(PanelFormato.errorVisible(e, "No se pudo cerrar la sesión."), "error");
    } finally {
      this.#cerrando.delete(numero);
      this.#pintar(); // quita la fila o, si falló, vuelve a habilitar su botón (aunque la lista se haya refrescado)
    }
  }

  #mostrarVacio(texto) {
    this.#vacio.textContent = texto;
    this.#vacio.hidden = !texto;
  }

  #mostrarAviso(texto, tipo = "info") {
    window.clearTimeout(this.#temporizadorAviso);
    PanelFormato.mensaje(this.#aviso, texto, tipo);
    if (texto) this.#temporizadorAviso = window.setTimeout(() => PanelFormato.mensaje(this.#aviso, ""), VentanaSesionesActivas.AVISO_MS);
  }
}
