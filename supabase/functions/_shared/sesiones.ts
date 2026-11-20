// Verificación completa del pase de un participante: firma, exp y rol (PaseParticipante) y, además,
// que no se haya emitido antes del último "Cerrar todas las sesiones" (sesiones_validas_desde).
// El acceso abierto/cerrado (abierto_hasta) NO se revisa aquí: solo bloquea entradas nuevas.
import { ErrorControlado } from "./entorno.ts";
import { PaseParticipante } from "./pase.ts";
import { ClienteRest } from "./supabase.ts";

export class VerificadorDeSesion {
  #pase: PaseParticipante;
  #servicio: ClienteRest;

  constructor(pase: PaseParticipante, servicio: ClienteRest) {
    this.#pase = pase;
    this.#servicio = servicio;
  }

  /**
   * true si el pase es válido y vigente. Lee sesiones_validas_desde de la base en cada llamada
   * (sin caché). iat va en segundos enteros: solo se acepta si es estrictamente posterior al cierre;
   * ante la duda por redondeo, se rechaza. Si la base no responde, lanza (la función falla cerrada).
   */
  async valida(token: string | null): Promise<boolean> {
    const datos = await this.#pase.leer(token);
    if (!datos) return false;
    const filas = await this.#servicio.consultar("config_acceso", { select: "sesiones_validas_desde", id: "eq.1" });
    const desdeMs = Date.parse(String(filas[0]?.sesiones_validas_desde ?? ""));
    if (filas.length !== 1 || !Number.isFinite(desdeMs)) throw new ErrorControlado("sesiones_validas_desde_ilegible");
    return datos.iat * 1000 > desdeMs;
  }
}
