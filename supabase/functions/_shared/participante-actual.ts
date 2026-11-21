// Contexto común de las funciones del feed: a partir del pase obtiene la sesión, el código anónimo del
// participante y su progreso. 401 si el pase no vale; 403 falta_registro si la sesión no se registró.
// Si la sesión está registrada pero falta el código o el progreso, lanza (falla cerrada).
import { ErrorControlado, type Entorno } from "./entorno.ts";
import { PaseParticipante } from "./pase.ts";
import { RegistroDeParticipantes } from "./participantes.ts";
import { type Progreso, RegistroDeProgreso } from "./progreso.ts";
import { VerificadorDeSesion } from "./sesiones.ts";
import { ClienteRest } from "./supabase.ts";

export type RechazoDeSesion = { estado: 401 | 403; error: string };
export type Participante = { codigo: string; progreso: Progreso };

export class ParticipanteActual {
  #verificador: VerificadorDeSesion;
  #participantes: RegistroDeParticipantes;
  #progreso: RegistroDeProgreso;

  constructor(entorno: Entorno, servicio: ClienteRest) {
    this.#verificador = new VerificadorDeSesion(new PaseParticipante(entorno.secreto("TOKEN_SECRETO")), servicio);
    this.#participantes = new RegistroDeParticipantes(servicio);
    this.#progreso = new RegistroDeProgreso(servicio);
  }

  async abrir(token: string | null): Promise<{ rechazo: RechazoDeSesion } | Participante> {
    const sesion = await this.#verificador.sesion(token);
    if (!sesion) return { rechazo: { estado: 401, error: "pase_invalido" } };
    if (!sesion.registrada) return { rechazo: { estado: 403, error: "falta_registro" } };
    const codigo = await this.#participantes.codigoDeSesion(sesion.numero);
    if (!codigo) throw new ErrorControlado("sin_codigo_participante");
    const progreso = await this.#progreso.leer(codigo);
    if (!progreso) throw new ErrorControlado("sin_progreso");
    return { codigo, progreso };
  }
}
