"use strict";

/**
 * Obtiene del servidor (Edge Function "codigo-actual") el código de acceso vigente, los segundos que
 * le quedan según la hora del servidor y hasta cuándo está abierto el acceso. También abre y cierra
 * el acceso. Usa el cliente de Supabase del panel, que manda el JWT del administrador.
 */
class ProveedorDeCodigo {
  static FUNCION = "codigo-actual";

  #cliente;

  constructor(clienteSupabase) {
    this.#cliente = clienteSupabase;
  }

  obtener() { return this.#llamar("consultar"); }

  abrirAcceso() { return this.#llamar("abrir"); }

  cerrarAcceso() { return this.#llamar("cerrar"); }

  /** Invalida todos los pases emitidos hasta ahora (no toca el acceso ni la sesión del panel). */
  cerrarSesiones() { return this.#llamar("cerrar_sesiones"); }

  /** { codigo, segundosRestantes, abiertoHasta (ms o null), sesionesValidasDesde (ms o null), desfaseMs } */
  async #llamar(accion) {
    let respuesta;
    try {
      respuesta = await this.#cliente.functions.invoke(ProveedorDeCodigo.FUNCION, { body: { accion } });
    } catch {
      throw new ErrorPanel("No hay conexión con el servidor del código.");
    }
    const { data, error } = respuesta;
    if (error) {
      const estado = error.context?.status;
      throw new ErrorPanel(estado === 401
        ? "El servidor no reconoce tu sesión de administrador. Vuelve a iniciar sesión."
        : "No se pudo obtener el código del servidor.");
    }
    const codigo = data?.codigo;
    const segundos = Number(data?.segundos_restantes);
    const ahoraServidor = Date.parse(data?.ahora ?? "");
    const abiertoHasta = data?.abierto_hasta == null ? null : Date.parse(data.abierto_hasta);
    const sesionesValidasDesde = data?.sesiones_validas_desde == null ? null : Date.parse(data.sesiones_validas_desde);
    if (typeof codigo !== "string" || !/^\d{8}$/.test(codigo) || !(segundos >= 0 && segundos <= 300) ||
        !Number.isFinite(ahoraServidor) || (abiertoHasta !== null && !Number.isFinite(abiertoHasta)) ||
        (sesionesValidasDesde !== null && !Number.isFinite(sesionesValidasDesde))) {
      throw new ErrorPanel("El servidor devolvió una respuesta inesperada.");
    }
    return { codigo, segundosRestantes: segundos, abiertoHasta, sesionesValidasDesde, desfaseMs: ahoraServidor - Date.now() };
  }
}

/** Pantalla de la pestaña Autenticación: código grande, círculo de tiempo, mm:ss, acceso y pantalla completa. */
class PestanaAutenticacion {
  static DURACION_VENTANA_MS = 5 * 60_000;
  static REFRESCO_MS = 250;
  static TRANSICION_MS = 350;
  static REINTENTO_MS = 3000;
  static PAUSA_TRAS_CAMBIO_MS = 400; // margen para pedir el siguiente código ya en la nueva ventana

  #proveedor;
  #dialogos;
  #codigo = null;
  #finVentana = 0;          // performance.now() en que termina la ventana, según el servidor
  #abiertoHasta = null;     // ms, en hora del servidor
  #desfaseMs = 0;
  #pidiendo = false;
  #siguienteIntento = 0;
  #intervalo = null;

  #escenario = document.getElementById("auth-escenario");
  #caja = document.getElementById("auth-codigo");
  #grupos = [document.getElementById("auth-grupo-1"), document.getElementById("auth-grupo-2")];
  #leyenda = document.getElementById("auth-leyenda");
  #arco = document.getElementById("auth-arco");
  #tiempo = document.getElementById("auth-tiempo");
  #botonPantalla = document.getElementById("auth-pantalla-completa");
  #interruptor = document.getElementById("auth-acceso");
  #botonCerrarSesiones = document.getElementById("auth-cerrar-sesiones");
  #estadoSesiones = document.getElementById("auth-estado-sesiones");
  #estadoAcceso = document.getElementById("auth-estado-acceso");
  #mensaje = document.getElementById("auth-mensaje");
  #longitudArco;

  constructor(proveedor, dialogos) {
    this.#proveedor = proveedor;
    this.#dialogos = dialogos;
    this.#longitudArco = 2 * Math.PI * Number(this.#arco.getAttribute("r")); // circunferencia del arco
    this.#arco.style.strokeDasharray = String(this.#longitudArco);
  }

  iniciar() {
    if (!this.#escenario.requestFullscreen) {
      this.#botonPantalla.disabled = true;
      this.#botonPantalla.title = "Este navegador no permite pantalla completa.";
    }
    this.#botonPantalla.addEventListener("click", () => this.#entrarPantallaCompleta());
    this.#interruptor.addEventListener("change", () => this.#cambiarAcceso());
    this.#botonCerrarSesiones.addEventListener("click", () => this.#cerrarSesiones());
    this.#pintarAcceso();
  }

  /** Al entrar a la pestaña: pide el código y empieza a contar (solo mientras se ve). */
  mostrar() {
    if (this.#intervalo !== null) return;
    this.#siguienteIntento = 0;
    this.#finVentana = 0;
    this.#intervalo = window.setInterval(() => this.#actualizar(), PestanaAutenticacion.REFRESCO_MS);
    this.#actualizar();
  }

  ocultar() {
    window.clearInterval(this.#intervalo);
    this.#intervalo = null;
    if (document.fullscreenElement === this.#escenario) document.exitFullscreen().catch(() => {});
  }

  #actualizar() {
    const restante = Math.max(0, this.#finVentana - performance.now());
    this.#pintarTiempo(restante);
    this.#pintarAcceso();
    if (restante === 0 && !this.#pidiendo && performance.now() >= this.#siguienteIntento) this.#pedirCodigo();
  }

  async #pedirCodigo() {
    this.#pidiendo = true;
    try {
      this.#aplicar(await this.#proveedor.obtener());
      PanelFormato.mensaje(this.#mensaje, "");
    } catch (e) {
      PanelFormato.mensaje(this.#mensaje, PanelFormato.errorVisible(e, "No se pudo obtener el código."), "error");
      this.#siguienteIntento = performance.now() + PestanaAutenticacion.REINTENTO_MS;
    } finally {
      this.#pidiendo = false;
    }
  }

  /** El tiempo restante sale del servidor (segundos_restantes), no del reloj de la PC. */
  #aplicar({ codigo, segundosRestantes, abiertoHasta, desfaseMs }) {
    this.#finVentana = performance.now() + segundosRestantes * 1000;
    // Justo en el borde de la ventana, espera un instante antes de pedir el siguiente.
    this.#siguienteIntento = this.#finVentana + PestanaAutenticacion.PAUSA_TRAS_CAMBIO_MS;
    this.#abiertoHasta = abiertoHasta;
    this.#desfaseMs = desfaseMs;
    if (codigo !== this.#codigo) this.#mostrarCodigo(codigo);
    this.#pintarTiempo(segundosRestantes * 1000);
    this.#pintarAcceso();
  }

  async #mostrarCodigo(codigo) {
    const primero = this.#codigo === null;
    this.#codigo = codigo;
    if (!primero) {
      this.#caja.classList.add("cambiando");
      await new Promise((r) => window.setTimeout(r, PestanaAutenticacion.TRANSICION_MS));
    }
    this.#grupos[0].textContent = codigo.slice(0, 4);
    this.#grupos[1].textContent = codigo.slice(4);
    this.#caja.setAttribute("aria-label", `Código ${codigo.slice(0, 4)} ${codigo.slice(4)}`);
    this.#caja.classList.remove("cambiando");
  }

  /** El círculo y el mm:ss salen del mismo valor, así bajan en sincronía. */
  #pintarTiempo(restanteMs) {
    const fraccion = Math.min(1, restanteMs / PestanaAutenticacion.DURACION_VENTANA_MS);
    this.#arco.style.strokeDashoffset = String(this.#longitudArco * (1 - fraccion));
    const segundos = Math.ceil(restanteMs / 1000);
    this.#tiempo.textContent = `${String(Math.floor(segundos / 60)).padStart(2, "0")}:${String(segundos % 60).padStart(2, "0")}`;
  }

  #accesoAbierto() {
    return this.#abiertoHasta !== null && this.#abiertoHasta > Date.now() + this.#desfaseMs;
  }

  #pintarAcceso() {
    const abierto = this.#accesoAbierto();
    if (!this.#interruptor.disabled) this.#interruptor.checked = abierto;
    this.#leyenda.hidden = abierto;
    this.#escenario.classList.toggle("cerrado", !abierto);
    this.#estadoAcceso.textContent = abierto
      ? `Acceso abierto · se cierra solo a las ${new Date(this.#abiertoHasta - this.#desfaseMs).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}`
      : "Acceso cerrado";
  }

  async #cambiarAcceso() {
    const abrir = this.#interruptor.checked;
    this.#interruptor.disabled = true;
    try {
      this.#aplicar(abrir ? await this.#proveedor.abrirAcceso() : await this.#proveedor.cerrarAcceso());
      PanelFormato.mensaje(this.#mensaje, "");
    } catch (e) {
      PanelFormato.mensaje(this.#mensaje, PanelFormato.errorVisible(e, "No se pudo cambiar el acceso."), "error");
    } finally {
      this.#interruptor.disabled = false;
      this.#pintarAcceso(); // si falló, el interruptor vuelve a su estado real
    }
  }

  /** Saca a todos los participantes: sus pases dejan de valer y sus feeds vuelven al acceso. */
  async #cerrarSesiones() {
    const confirmado = await this.#dialogos.confirmar(
      "¿Cerrar todas las sesiones de los participantes? Todos los feeds abiertos volverán a la pantalla de acceso en unos segundos. El acceso con código no cambia.",
      "Cerrar todas las sesiones",
    );
    if (!confirmado) return;
    this.#botonCerrarSesiones.disabled = true;
    try {
      const respuesta = await this.#proveedor.cerrarSesiones();
      if (respuesta.sesionesValidasDesde === null) throw new ErrorPanel("El servidor no confirmó el cierre de sesiones.");
      this.#aplicar(respuesta);
      const hora = new Date(respuesta.sesionesValidasDesde - respuesta.desfaseMs)
        .toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
      PanelFormato.mensaje(this.#estadoSesiones, `Sesiones cerradas a las ${hora}`, "exito");
    } catch (e) {
      PanelFormato.mensaje(this.#estadoSesiones, PanelFormato.errorVisible(e, "No se pudieron cerrar las sesiones."), "error");
    } finally {
      this.#botonCerrarSesiones.disabled = false;
    }
  }

  async #entrarPantallaCompleta() {
    try {
      await this.#escenario.requestFullscreen({ navigationUI: "hide" });
    } catch {
      PanelFormato.mensaje(this.#mensaje, "El navegador no permitió la pantalla completa.", "error");
    }
  }
}
