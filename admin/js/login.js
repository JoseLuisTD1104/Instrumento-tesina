"use strict";

/** Pantalla de inicio de sesión. */
class LoginPage {
  static ESPERA_TRAS_FALLO_MS = 2000; // solo frena clics repetidos; el límite real lo aplica Supabase

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
    if (await this.#auth.haySesionValida()) {
      window.location.replace("panel.html");
      return;
    }
    document.body.classList.remove("verificando");
    this.#form.addEventListener("submit", (e) => this.#enviar(e));
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

  static mostrarErrorDeConfiguracion() {
    document.body.classList.remove("verificando");
    const error = document.getElementById("error");
    error.textContent = "El panel no está configurado. Revisa admin/config.js.";
    error.hidden = false;
    document.getElementById("form-login").hidden = true;
  }
}

protegerContraIframe();
try {
  new LoginPage(AdminLogin.desdeConfig()).iniciar();
} catch (e) {
  LoginPage.mostrarErrorDeConfiguracion();
}
