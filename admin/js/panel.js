"use strict";

/** Pantalla del panel: solo se muestra con sesión válida. */
class PanelPage {
  #auth;
  #saliendo = false;
  #administrar = null;

  constructor(auth) {
    this.#auth = auth;
  }

  async iniciar() {
    if (!(await this.#auth.haySesionValida())) {
      window.location.replace("./");
      return;
    }
    const repo = new VideoRepositorio(this.#auth.clienteSupabase(), window.CORTO_CONFIG);
    const dialogos = new Dialogos();
    const subir = new PestanaSubir(repo, dialogos);
    this.#administrar = new PestanaAdministrar(repo, dialogos);
    subir.alSubir(() => this.#administrar.marcarDesactualizada());
    subir.iniciar();
    this.#administrar.iniciar();

    document.body.classList.remove("verificando");
    this.#auth.alCerrarseSesion(() => { if (!this.#saliendo) window.location.replace("./"); });
    this.#activarPestanas();
    document.getElementById("cerrar-sesion").addEventListener("click", async (e) => {
      this.#saliendo = true;
      e.currentTarget.disabled = true;
      await this.#auth.cerrarSesion();
      window.location.replace("./");
    });
  }

  // ---- Cambio de pestañas (incluye flechas del teclado) ----
  #activarPestanas() {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const activar = (tab) => {
      tabs.forEach((t) => {
        const activa = t === tab;
        t.setAttribute("aria-selected", String(activa));
        t.tabIndex = activa ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !activa;
      });
      tab.focus();
      if (tab.id === "tab-administrar") this.#administrar.mostrar();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => activar(tab));
      tab.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") activar(tabs[(i + 1) % tabs.length]);
        if (e.key === "ArrowLeft") activar(tabs[(i - 1 + tabs.length) % tabs.length]);
      });
    });
  }
}

protegerContraIframe();
try {
  new PanelPage(AdminLogin.desdeConfig()).iniciar().catch(() => window.location.replace("./"));
} catch {
  // No se pudo arrancar: no se muestra el panel; el login explica la causa.
  window.location.replace("./");
}
