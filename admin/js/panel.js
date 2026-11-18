"use strict";

/** Pantalla del panel: solo se muestra con sesión válida. */
class PanelPage {
  #auth;
  #saliendo = false;

  constructor(auth) {
    this.#auth = auth;
  }

  async iniciar() {
    if (!(await this.#auth.haySesionValida())) {
      window.location.replace("./");
      return;
    }
    document.body.classList.remove("verificando");
    this.#auth.alCerrarseSesion(() => { if (!this.#saliendo) window.location.replace("./"); });
    this.#activarPestanas();
    this.#activarZonaDeSubida();
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
        t.setAttribute("aria-selected", activa);
        t.tabIndex = activa ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !activa;
      });
      tab.focus();
    };
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => activar(tab));
      tab.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") activar(tabs[(i + 1) % tabs.length]);
        if (e.key === "ArrowLeft") activar(tabs[(i - 1 + tabs.length) % tabs.length]);
      });
    });
  }

  // ---- Explorador de archivos (solo elegir, no sube nada) ----
  #activarZonaDeSubida() {
    const zona = document.getElementById("dropzone");
    const selector = document.getElementById("selector");

    zona.addEventListener("dblclick", () => selector.click());
    zona.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selector.click(); }
    });

    // Evitar que el navegador abra el video al soltarlo y salga del panel
    ["dragenter", "dragover"].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove("over"); }));
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());
  }
}

protegerContraIframe();
try {
  new PanelPage(AdminLogin.desdeConfig()).iniciar();
} catch (e) {
  // Configuración inválida: no se muestra el panel.
  window.location.replace("./");
}
