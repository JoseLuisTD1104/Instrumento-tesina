// Edge Function "avanzar-etapa" (pública con pase). Con { accion: "comenzar" } pasa al participante de la
// etapa "instruccion" a "ciega" con una actualización condicionada (solo si sigue en "instruccion") y
// responde 204 sin cuerpo. Cualquier otro cuerpo o etapa recibe el mismo rechazo genérico.
// Nunca se registran pases, códigos ni IPs.
import { Entorno, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { ParticipanteActual } from "../_shared/participante-actual.ts";
import { RegistroDeProgreso } from "../_shared/progreso.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "avanzar-etapa";
const MAX_CUERPO_BYTES = 1024;

/** true solo para exactamente { accion: "comenzar" }. */
function esComenzar(cuerpo: unknown): boolean {
  if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) return false;
  const c = cuerpo as Record<string, unknown>;
  return Object.keys(c).length === 1 && c.accion === "comenzar";
}

export async function manejar(peticion: Request, leer: LectorEntorno): Promise<Response> {
  const entorno = new Entorno(leer);
  let canal: CanalHttp;
  try {
    canal = new CanalHttp(entorno.requerido("ORIGEN_PERMITIDO"), ["POST"]);
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return new Response(null, { status: 500 });
  }
  const corte = canal.filtrar(peticion);
  if (corte) return corte;

  try {
    // 1) Pase válido, sesión vigente y registrada (401 / 403 falta_registro, igual que feed-videos).
    const servicio = ClienteRest.deServicio(entorno);
    const participante = await new ParticipanteActual(entorno, servicio).abrir(CanalHttp.bearer(peticion));
    if ("rechazo" in participante) return canal.json(participante.rechazo.estado, { error: participante.rechazo.error });

    // 2) Cuerpo exacto.
    let cuerpo: unknown;
    try {
      cuerpo = await CanalHttp.leerJson(peticion, MAX_CUERPO_BYTES);
    } catch {
      return canal.rechazo();
    }
    if (!esComenzar(cuerpo)) return canal.rechazo();

    // 3) Solo desde "instruccion"; la condición se repite en la actualización por si llegan dos a la vez.
    if (participante.progreso.etapa !== "instruccion") return canal.rechazo();
    const cambio = await new RegistroDeProgreso(servicio).cambiarEtapa(participante.codigo, "instruccion", "ciega", Date.now());
    return cambio ? canal.vacio(204) : canal.rechazo();
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
