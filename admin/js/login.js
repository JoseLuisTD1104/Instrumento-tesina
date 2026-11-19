"use strict";

/** Pantalla de inicio de sesión. */
class LoginPage {
  static ESPERA_TRAS_FALLO_MS = 2000; // solo frena clics repetidos; el límite real lo aplica Supabase
  static MENSAJES_CIERRE = Object.freeze({ seguridad: "Tu sesión se cerró por seguridad" });

  #auth;
  #form;
  #error;
  #boton;

  constructor(auth) {
    this.#auth = auth;
    this.#form = document.getElementById("form-login");
    this.#error = document.getElementById("error");
    this.#boton = this.#form.querySelector('button[type="submit"]');
  }

  async iniciar() {
    const estado = await this.#auth.verificarSesion();
    if (estado === AdminLogin.ESTADOS_SESION.VALIDA) {
      window.location.replace("panel.html");
      return;
    }
    this.#mostrarMotivoDeCierre(estado === AdminLogin.ESTADOS_SESION.RECHAZADA ? "seguridad" : null);
    document.body.classList.remove("verificando");
    this.#form.addEventListener("submit", (e) => this.#enviar(e));
  }

  /** Muestra por qué se cerró la sesión (?motivo=seguridad o una sesión rechazada aquí) y limpia la URL. */
  #mostrarMotivoDeCierre(motivoLocal) {
    const motivo = motivoLocal ?? new URLSearchParams(window.location.search).get("motivo");
    const texto = LoginPage.MENSAJES_CIERRE[motivo];
    if (!texto) return;
    const aviso = document.getElementById("aviso");
    aviso.textContent = texto;
    aviso.hidden = false;
    window.history.replaceState(null, "", window.location.pathname);
  }

  async #enviar(e) {
    e.preventDefault();
    this.#mostrarError("");
    this.#boton.disabled = true;

    const datos = new FormData(this.#form);
    const resultado = await this.#auth.iniciarSesion(datos.get("correo"), datos.get("password"));
    this.#form.password.value = "";

    if (resultado.ok) {
      window.location.replace("panel.html");
      return;
    }
    this.#mostrarError(resultado.mensaje);
    setTimeout(() => { this.#boton.disabled = false; }, LoginPage.ESPERA_TRAS_FALLO_MS);
  }

  #mostrarError(texto) {
    this.#error.textContent = texto; // textContent: nunca se interpreta como HTML
    this.#error.hidden = !texto;
  }

  static mostrarErrorDeArranque(error) {
    const texto = error instanceof ConfiguracionInvalida
      ? error.message
      : "No se pudo cargar el panel. Recarga la página e intenta de nuevo.";
    document.body.classList.remove("verificando");
    const caja = document.getElementById("error");
    caja.textContent = texto;
    caja.hidden = false;
    document.getElementById("form-login").hidden = true;
  }
}

protegerContraIframe();
try {
  new LoginPage(AdminLogin.desdeConfig()).iniciar().catch(LoginPage.mostrarErrorDeArranque);
} catch (e) {
  LoginPage.mostrarErrorDeArranque(e);
}
