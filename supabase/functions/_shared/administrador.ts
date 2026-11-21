// Verificación del administrador para las funciones del panel: el JWT de la sesión se verifica con
// Supabase Auth (auth.getUser) y el id del usuario se compara con ADMIN_UID en tiempo constante.
// Cualquier duda (sin token, apikey rara, usuario distinto) se trata como no autorizado: falla cerrada.
import { type Entorno } from "./entorno.ts";
import { CanalHttp } from "./http.ts";
import { GeneradorDeCodigo } from "./codigo.ts";
import { ClienteRest } from "./supabase.ts";

export class VerificadorDeAdministrador {
  static PATRON_APIKEY = /^(sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_\-.]+)$/;

  #entorno: Entorno;

  constructor(entorno: Entorno) {
    this.#entorno = entorno;
  }

  /** Cliente con los permisos del administrador si la petición es suya; null si no. */
  async verificar(peticion: Request): Promise<ClienteRest | null> {
    const jwt = CanalHttp.bearer(peticion);
    const apikey = peticion.headers.get("apikey") ?? this.#entorno.opcional("SUPABASE_ANON_KEY") ?? "";
    if (!jwt || !VerificadorDeAdministrador.PATRON_APIKEY.test(apikey)) return null;
    const comoAdmin = new ClienteRest(this.#entorno.urlProyecto(), apikey, jwt);
    const usuario = await comoAdmin.usuarioActual();
    if (!usuario || !GeneradorDeCodigo.iguales(usuario.id, this.#entorno.requerido("ADMIN_UID"))) return null;
    return comoAdmin;
  }
}
