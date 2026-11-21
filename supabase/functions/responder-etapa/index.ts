// Edge Function "responder-etapa" (pública con pase). Solo POST con JSON de máx. 4 KB y el pase, verificado
// igual que feed-videos (401 / 403 falta_registro). Cuerpo { etapa, marcados: [uuid], ninguno: boolean }
// (en "revelacion", solo { etapa }). Solo vale si etapa es la etapa actual del participante:
// - "conoce": marcados ⊆ actores de sus videos; una fila por actor en respuestas_conoce → "convencio".
// - "convencio": marcados ⊆ su orden_ciego; una fila por video en respuestas_video (pregunta "haria",
//   posicion = lugar en orden_ciego desde 1) → "revelacion".
// - "revelacion": solo si pasaron al menos 10 s desde que entró (actualizado_en); guarda
//   revelacion_aceptada_en → "memoria".
// - "memoria": igual que "convencio" con pregunta "deepfake" → "evaluacion".
// Sin duplicados; marcados vacío ⇔ ninguno true. Las filas se insertan en una sola sentencia (la clave
// primaria impide una segunda inserción) y la etapa avanza con una actualización condicionada a la etapa
// anterior; si no avanza, se borran las filas insertadas. Cualquier otra cosa: rechazo genérico.
// Responde 200 con { etapa } (la nueva) y nada más. Nunca registra pases, códigos ni ids.
import { Entorno, ErrorConflicto, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { type Participante, ParticipanteActual } from "../_shared/participante-actual.ts";
import { type Etapa, RegistroDeProgreso } from "../_shared/progreso.ts";
import { actoresDe, VideosDeReconocimiento } from "../_shared/reconocimiento.ts";
import {
  PREGUNTA_DE_ETAPA, RegistroDeRespuestas, type Respuesta, SIGUIENTE_ETAPA, ValidadorDeRespuesta,
} from "../_shared/respuestas.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "responder-etapa";
const MAX_CUERPO_BYTES = 4096;
const MIN_REVELACION_MS = 10_000;

/** Guarda la respuesta de la etapa actual y avanza. Devuelve la etapa nueva, o null si se rechaza. */
class ContestadorDeEtapa {
  #servicio: ClienteRest;
  #progreso: RegistroDeProgreso;
  #respuestas: RegistroDeRespuestas;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
    this.#progreso = new RegistroDeProgreso(servicio);
    this.#respuestas = new RegistroDeRespuestas(servicio);
  }

  async contestar({ codigo, progreso }: Participante, respuesta: Respuesta, ahoraMs: number): Promise<Etapa | null> {
    const desde = progreso.etapa;
    const hacia = SIGUIENTE_ETAPA[desde];
    if (!hacia) return null;

    if (desde === "revelacion") {
      // La condición de tiempo también va en la actualización: la base decide con su propio actualizado_en.
      if (ahoraMs - progreso.actualizadoEnMs < MIN_REVELACION_MS) return null;
      const limite = new Date(ahoraMs - MIN_REVELACION_MS).toISOString();
      const cambio = await this.#progreso.cambiarEtapa(codigo, desde, hacia, ahoraMs, {
        condiciones: { actualizado_en: `lte.${limite}` }, extra: { revelacion_aceptada_en: new Date(ahoraMs).toISOString() },
      });
      return cambio ? hacia : null;
    }

    let insertar: () => Promise<void>;
    let deshacer: () => Promise<void>;
    if (desde === "conoce") {
      const actores = actoresDe(await new VideosDeReconocimiento(this.#servicio).enOrden(progreso.orden));
      if (!ValidadorDeRespuesta.pertenecen(respuesta.marcados, actores)) return null;
      insertar = () => this.#respuestas.insertarConoce(codigo, actores, respuesta.marcados, ahoraMs);
      deshacer = () => this.#respuestas.borrarConoce(codigo);
    } else {
      const pregunta = PREGUNTA_DE_ETAPA[desde];
      if (!pregunta || !ValidadorDeRespuesta.pertenecen(respuesta.marcados, progreso.orden)) return null;
      insertar = () => this.#respuestas.insertarVideos(codigo, progreso.orden, respuesta.marcados, pregunta, ahoraMs);
      deshacer = () => this.#respuestas.borrarVideos(codigo, pregunta);
    }

    try {
      await insertar();
    } catch (e) {
      if (e instanceof ErrorConflicto) return null; // ya contestó (p. ej., dos peticiones a la vez)
      throw e;
    }
    let cambio: boolean;
    try {
      cambio = await this.#progreso.cambiarEtapa(codigo, desde, hacia, ahoraMs);
    } catch (e) {
      // No se sabe si la actualización llegó a la base: se vuelve a leer antes de borrar nada.
      const actual = await this.#progreso.leer(codigo).catch(() => null);
      if (actual?.etapa === hacia) return hacia;
      if (actual?.etapa === desde) await deshacer().catch((e2) => CanalHttp.registrarError(FUNCION, e2));
      throw e;
    }
    if (!cambio) await deshacer().catch((e) => CanalHttp.registrarError(FUNCION, e));
    return cambio ? hacia : null;
  }
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
    // 1) Pase válido, sesión vigente y registrada.
    const servicio = ClienteRest.deServicio(entorno);
    const participante = await new ParticipanteActual(entorno, servicio).abrir(CanalHttp.bearer(peticion));
    if ("rechazo" in participante) return canal.json(participante.rechazo.estado, { error: participante.rechazo.error });

    // 2) Cuerpo exacto para la etapa actual.
    let cuerpo: unknown;
    try {
      cuerpo = await CanalHttp.leerJson(peticion, MAX_CUERPO_BYTES);
    } catch {
      return canal.rechazo();
    }
    const respuesta = ValidadorDeRespuesta.validar(cuerpo, participante.progreso.etapa);
    if (!respuesta) return canal.rechazo();

    // 3) Guardar y avanzar.
    const nueva = await new ContestadorDeEtapa(servicio).contestar(participante, respuesta, Date.now());
    return nueva ? canal.json(200, { etapa: nueva }) : canal.rechazo();
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
