"use strict";

/**
 * Login de la única persona administradora de "corto" con Supabase Auth.
 * Clase independiente de las pantallas: el login y el panel solo usan sus métodos.
 */
class ConfiguracionInvalida extends Error {}

class AdminLogin {
  static MAX_CORREO = 254;
  static MAX_PASSWORD = 128;

  static MENSAJES = Object.freeze({
    credenciales: "Correo o contraseña incorrectos.",
    bloqueado: "Demasiados intentos. Espera unos minutos e intenta de nuevo.",
    servicio: "No se pudo iniciar sesión en este momento. Intenta más tarde.",
  });

  #cliente;

  constructor(config, libreria) {
    const url = String(config?.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const clave = String(config?.SUPABASE_PUBLISHABLE_KEY || "").trim();

    let partes;
    try { partes = new URL(url); } catch { partes = null; }
    if (!partes || partes.protocol !== "https:" || !partes.hostname.includes(".")) {
      throw new ConfiguracionInvalida("SUPABASE_URL falta o no es una URL https completa.");
    }
    if (!clave.startsWith("sb_publishable_")) {
      throw new ConfiguracionInvalida("SUPABASE_PUBLISHABLE_KEY falta o no es una clave publicable.");
    }
    if (!libreria?.createClient) {
      throw new ConfiguracionInvalida("No se cargó supabase-js.");
    }

    this.#cliente = libreria.createClient(url, clave, {
      auth: {
        // sessionStorage: la sesión se borra al cerrar la pestaña y no la comparten otras pestañas.
        storage: window.sessionStorage,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }

  static desdeConfig() {
    return new AdminLogin(window.CORTO_CONFIG, window.supabase);
  }

  /** Devuelve { ok: true } o { ok: false, motivo, mensaje } sin decir qué dato falló. */
  async iniciarSesion(correo, password) {
    const valido =
      typeof correo === "string" && typeof password === "string" &&
      correo.length >= 3 && correo.length <= AdminLogin.MAX_CORREO && correo.includes("@") &&
      password.length > 0 && password.length <= AdminLogin.MAX_PASSWORD;
    if (!valido) return this.#fallo("credenciales");

    try {
      const { data, error } = await this.#cliente.auth.signInWithPassword({
        email: correo.trim(),
        password,
      });
      if (error) {
        if (error.status === 429) return this.#fallo("bloqueado");
        if (!error.status || error.status >= 500) return this.#fallo("servicio");
        return this.#fallo("credenciales");
      }
      return data?.session ? { ok: true } : this.#fallo("credenciales");
    } catch {
      return this.#fallo("servicio");
    }
  }

  /** Verifica la sesión con el servidor de Supabase, no solo con lo guardado en el navegador. */
  async haySesionValida() {
    try {
      const { data: s } = await this.#cliente.auth.getSession();
      if (!s?.session) return false;
      const { data, error } = await this.#cliente.auth.getUser();
      if (error || !data?.user) {
        await this.#cliente.auth.signOut({ scope: "local" });
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Cierra la sesión y revoca los refresh tokens en Supabase. */
  async cerrarSesion() {
    try {
      await this.#cliente.auth.signOut({ scope: "global" });
    } catch {
      // Si Supabase no responde, al menos se borra la sesión local.
      await this.#cliente.auth.signOut({ scope: "local" }).catch(() => {});
    } finally {
      window.sessionStorage.clear();
    }
  }

  /** Para el resto del panel: avisa cuando la sesión termina (vence, se revoca o se cierra). */
  alCerrarseSesion(callback) {
    this.#cliente.auth.onAuthStateChange((evento, sesion) => {
      if (evento === "SIGNED_OUT" || !sesion) callback();
    });
  }

  #fallo(motivo) {
    return { ok: false, motivo, mensaje: AdminLogin.MENSAJES[motivo] };
  }
}

/** Evita que otra página meta el panel en un iframe (GitHub Pages no permite la cabecera). */
function protegerContraIframe() {
  if (window.top !== window.self) {
    document.documentElement.textContent = "";
    throw new Error("El panel no se puede mostrar dentro de otra página.");
  }
}
