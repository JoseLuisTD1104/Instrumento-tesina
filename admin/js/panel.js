"use strict";

/** Pantalla del panel: solo se muestra con sesión válida. */
class PanelPage {
  #auth;
  #guardia = null;
  #administrar = null;
  #comentarios = null;

  constructor(auth) {
    this.#auth = auth;
  }

  async iniciar() {
    if (!(await this.#auth.haySesionValida())) {
      window.location.replace("./");
      return;
    }
    const subidas = new MonitorDeSubidas();
    this.#guardia = new GuardiaDeSesion(this.#auth, subidas, new AvisoDeSesion(document.getElementById("dialogo-sesion")));
    const repo = new VideoRepositorio(this.#auth.clienteSupabase(), window.CORTO_CONFIG, subidas);
    const dialogos = new Dialogos();
    const subir = new PestanaSubir(repo, dialogos);
    this.#administrar = new PestanaAdministrar(repo, dialogos);
    subir.alSubir(() => this.#administrar.marcarDesactualizada());
    this.#comentarios = new PestanaComentarios(repo, new ComentarioRepositorio(this.#auth.clienteSupabase(), repo), dialogos);
    subir.iniciar();
    this.#administrar.iniciar();
    this.#comentarios.iniciar();

    document.body.classList.remove("verificando");
    // Si Supabase termina la sesión por su cuenta (token revocado o vencido), también se sale.
    this.#auth.alCerrarseSesion(() => {
      if (!this.#guardia.cerrando) window.location.replace(GuardiaDeSesion.DESTINO_CIERRE);
    });
    this.#activarPestanas();
    document.getElementById("cerrar-sesion").addEventListener("click", (e) => {
      e.currentTarget.disabled = true;
      this.#guardia.cerrar();
    });
    this.#guardia.iniciar();
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
      if (tab.id === "tab-comentarios") this.#comentarios.mostrar();
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
