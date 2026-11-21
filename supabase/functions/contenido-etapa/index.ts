// Edge Function "contenido-etapa" (pública con pase). Solo GET, con el pase en Authorization, verificado
// igual que feed-videos (401 pase_invalido; 403 falta_registro). Según la etapa del participante devuelve:
// - "conoce": { etapa, actores: [{ id, cara_url }] }, una fila por actor distinto entre los videos de su
//   orden_ciego, en un orden pseudoaleatorio estable por participante (SHA-256 de código + id de actor).
//   Los videos sin actor se ignoran; si ninguno tiene, actores va vacía.
// - "convencio" y "memoria": { etapa, videos: [{ id, miniatura_url }] } en el orden de su orden_ciego;
//   un video sin miniatura va con miniatura_url null.
// - "revelacion": { etapa, segundos_transcurridos } desde que entró a la etapa (actualizado_en).
// - "resultado": { etapa, aciertos, total }, calculado aquí con respuestas_evaluacion y clasificacion_videos
//   (ver CalculadoraDeResultado). Nunca el detalle por video, el origen ni el tipo.
// - Cualquier otra etapa (incluida "exposicion"): { etapa }.
// Las URLs son firmadas de 10 minutos del bucket privado "reconocimiento". Nunca devuelve el código, el
// número de video, el origen de los videos ni nada que revele cuáles son de IA.
import { Entorno, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { ParticipanteActual } from "../_shared/participante-actual.ts";
import { type Progreso } from "../_shared/progreso.ts";
import {
  actoresDe, AlmacenDeReconocimiento, OrdenEstable, RegistroDeActores, VideosDeReconocimiento,
} from "../_shared/reconocimiento.ts";
import { RegistroDeClasificacion } from "../_shared/clasificacion.ts";
import { CalculadoraDeResultado, RegistroDeEvaluaciones } from "../_shared/evaluaciones.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "contenido-etapa";

/** Arma el contenido de cada etapa. Cada método devuelve solo lo que esa pantalla necesita. */
class ContenidoDeEtapa {
  #videos: VideosDeReconocimiento;
  #actores: RegistroDeActores;
  #almacen: AlmacenDeReconocimiento;
  #evaluaciones: RegistroDeEvaluaciones;
  #clasificacion: RegistroDeClasificacion;

  constructor(servicio: ClienteRest) {
    this.#videos = new VideosDeReconocimiento(servicio);
    this.#actores = new RegistroDeActores(servicio);
    this.#almacen = new AlmacenDeReconocimiento(servicio);
    this.#evaluaciones = new RegistroDeEvaluaciones(servicio);
    this.#clasificacion = new RegistroDeClasificacion(servicio);
  }

  async de(codigo: string, progreso: Progreso, ahoraMs: number): Promise<Record<string, unknown>> {
    const { etapa } = progreso;
    if (etapa === "conoce") return { etapa, actores: await this.#caras(codigo, progreso.orden) };
    if (etapa === "convencio" || etapa === "memoria") return { etapa, videos: await this.#miniaturas(progreso.orden) };
    if (etapa === "revelacion") {
      return { etapa, segundos_transcurridos: Math.max(0, Math.floor((ahoraMs - progreso.actualizadoEnMs) / 1000)) };
    }
    if (etapa === "resultado") return { etapa, ...await this.#resultado(codigo, progreso.ordenEvaluacion ?? []) };
    return { etapa };
  }

  /** Solo los dos números: aciertos y total de videos con clasificación. */
  async #resultado(codigo: string, orden: string[]): Promise<{ aciertos: number; total: number }> {
    const [respuestas, origenes] = await Promise.all([this.#evaluaciones.respuestas(codigo), this.#clasificacion.origenes(orden)]);
    return CalculadoraDeResultado.calcular(orden, respuestas, origenes);
  }

  async #caras(codigo: string, orden: string[]): Promise<{ id: string; cara_url: string }[]> {
    const ids = await OrdenEstable.ordenar(codigo, actoresDe(await this.#videos.enOrden(orden)));
    const actores = await this.#actores.enOrden(ids);
    const urls = await this.#almacen.firmar("caras", actores.map((a) => a.cara_ruta));
    return actores.map((a) => ({ id: a.id, cara_url: urls.get(a.cara_ruta)! }));
  }

  async #miniaturas(orden: string[]): Promise<{ id: string; miniatura_url: string | null }[]> {
    const videos = await this.#videos.enOrden(orden);
    const rutas = videos.map((v) => v.miniatura_ruta).filter((r): r is string => r !== null);
    const urls = await this.#almacen.firmar("miniaturas", rutas);
    return videos.map((v) => ({ id: v.id, miniatura_url: v.miniatura_ruta ? urls.get(v.miniatura_ruta)! : null }));
  }
}

export async function manejar(peticion: Request, leer: LectorEntorno): Promise<Response> {
  const entorno = new Entorno(leer);
  let canal: CanalHttp;
  try {
    canal = new CanalHttp(entorno.requerido("ORIGEN_PERMITIDO"), ["GET"]);
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return new Response(null, { status: 500 });
  }
  const corte = canal.filtrar(peticion);
  if (corte) return corte;

  try {
    if ([...new URL(peticion.url).searchParams.keys()].length) return canal.rechazo();
    const servicio = ClienteRest.deServicio(entorno);
    const participante = await new ParticipanteActual(entorno, servicio).abrir(CanalHttp.bearer(peticion));
    if ("rechazo" in participante) return canal.json(participante.rechazo.estado, { error: participante.rechazo.error });
    return canal.json(200, await new ContenidoDeEtapa(servicio).de(participante.codigo, participante.progreso, Date.now()));
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
