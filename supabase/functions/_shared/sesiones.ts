// Sesiones de participantes:
// - VerificadorDeSesion: un pase vale solo si su firma, exp y rol son correctos (PaseParticipante), se
//   emitió después del último "Cerrar todas las sesiones" (sesiones_validas_desde) y su jti tiene una
//   fila en sesiones_activas sin revocar y sin vencer. El acceso abierto/cerrado NO se revisa aquí.
// - RegistroDeSesiones: altas, listado y cierre individual en sesiones_activas (solo clave de servicio).
import { ErrorControlado } from "./entorno.ts";
import { PaseParticipante } from "./pase.ts";
import { ClienteRest } from "./supabase.ts";

const TABLA = "sesiones_activas";

export class RegistroDeSesiones {
  static RETENCION_VENCIDAS_MS = 24 * 3600_000;
  static MAX_LISTADO = 1000;

  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  /** Registra la sesión de un pase recién emitido. Si falla, lanza (el pase no se entrega). */
  async registrar(jti: string, expiraEnMs: number): Promise<void> {
    await this.#servicio.insertar(TABLA, { jti, expira_en: new Date(expiraEnMs).toISOString() });
  }

  /** Borra las filas vencidas hace más de 1 día. */
  async limpiarVencidas(ahoraMs: number): Promise<void> {
    await this.#servicio.borrar(TABLA, { expira_en: `lt.${new Date(ahoraMs - RegistroDeSesiones.RETENCION_VENCIDAS_MS).toISOString()}` });
  }

  /** true si el jti tiene una fila sin revocar y con expira_en futura. Consulta la base cada vez. */
  async vigente(jti: string, ahoraMs: number): Promise<boolean> {
    const filas = await this.#servicio.consultar(TABLA, {
      select: "numero", jti: `eq.${jti}`, revocada_en: "is.null", expira_en: `gt.${new Date(ahoraMs).toISOString()}`, limit: "1",
    });
    return filas.length === 1;
  }

  /** Sesiones no revocadas y no vencidas, ordenadas por número. Nunca incluye el jti. */
  async listar(ahoraMs: number): Promise<{ numero: number; nombre: string | null; creado_en: string }[]> {
    const filas = await this.#servicio.consultar(TABLA, {
      select: "numero,nombre,creado_en", revocada_en: "is.null", expira_en: `gt.${new Date(ahoraMs).toISOString()}`,
      order: "numero.asc", limit: String(RegistroDeSesiones.MAX_LISTADO),
    });
    return filas.map((f) => ({
      numero: Number(f.numero),
      nombre: typeof f.nombre === "string" ? f.nombre : null,
      creado_en: String(f.creado_en ?? ""),
    }));
  }

  /** Revoca la sesión con ese número (si existe y sigue sin revocar). No informa si existía. */
  async revocar(numero: number, ahoraMs: number): Promise<void> {
    await this.#servicio.actualizar(TABLA, { numero: `eq.${numero}`, revocada_en: "is.null", select: "numero" },
      { revocada_en: new Date(ahoraMs).toISOString() });
  }
}

export class VerificadorDeSesion {
  #pase: PaseParticipante;
  #servicio: ClienteRest;
  #registro: RegistroDeSesiones;

  constructor(pase: PaseParticipante, servicio: ClienteRest) {
    this.#pase = pase;
    this.#servicio = servicio;
    this.#registro = new RegistroDeSesiones(servicio);
  }

  /**
   * true si el pase es válido y vigente. Lee sesiones_validas_desde y la fila de sesiones_activas en
   * cada llamada (sin caché). iat va en segundos enteros: solo se acepta si es estrictamente posterior
   * al cierre; ante la duda por redondeo, se rechaza. Si la base no responde, lanza (falla cerrada).
   */
  async valida(token: string | null): Promise<boolean> {
    const datos = await this.#pase.leer(token);
    if (!datos) return false;
    const ahora = Date.now();
    const [filas, vigente] = await Promise.all([
      this.#servicio.consultar("config_acceso", { select: "sesiones_validas_desde", id: "eq.1" }),
      this.#registro.vigente(datos.jti, ahora),
    ]);
    const desdeMs = Date.parse(String(filas[0]?.sesiones_validas_desde ?? ""));
    if (filas.length !== 1 || !Number.isFinite(desdeMs)) throw new ErrorControlado("sesiones_validas_desde_ilegible");
    return vigente && datos.iat * 1000 > desdeMs;
  }
}
