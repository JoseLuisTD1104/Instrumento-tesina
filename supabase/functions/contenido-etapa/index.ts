// Edge Function "contenido-etapa" (pública con pase). Solo GET, con el pase en Authorization, verificado
// igual que feed-videos (401 pase_invalido; 403 falta_registro). Según la etapa del participante devuelve:
// - "conoce": { etapa, actores: [{ id, cara_url }] }, una fila por actor distinto entre los videos de su
//   orden_ciego, en un orden pseudoaleatorio estable por participante (SHA-256 de código + id de actor).
// - "convencio" y "memoria": { etapa, videos: [{ id, miniatura_url }] } en el orden de su orden_ciego.
// - "revelacion": { etapa, segundos_transcurridos } desde que entró a la etapa (actualizado_en).
// - Cualquier otra etapa: { etapa }.
// Las URLs son firmadas de 10 minutos del bucket privado "reconocimiento". Nunca devuelve el código, el
// número de video, el origen de los videos ni nada que revele cuáles son de IA. Si falta material (un video
// sin actor o sin miniatura), falla cerrada con la respuesta genérica de servicio.
import { Entorno, ErrorControlado, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { ParticipanteActual } from "../_shared/participante-actual.ts";
import { type Progreso } from "../_shared/progreso.ts";
import {
  actoresDe, AlmacenDeReconocimiento, OrdenEstable, RegistroDeActores, VideosDeReconocimiento,
} from "../_shared/reconocimiento.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "contenido-etapa";

/** Arma el contenido de cada etapa. Cada método devuelve solo lo que esa pantalla necesita. */
class ContenidoDeEtapa {
  #videos: VideosDeReconocimiento;
  #actores: RegistroDeActores;
  #almacen: AlmacenDeReconocimiento;

  constructor(servicio: ClienteRest) {
    this.#videos = new VideosDeReconocimiento(servicio);
    this.#actores = new RegistroDeActores(servicio);
    this.#almacen = new AlmacenDeReconocimiento(servicio);
  }

  async de(codigo: string, progreso: Progreso, ahoraMs: number): Promise<Record<string, unknown>> {
    const { etapa } = progreso;
    if (etapa === "conoce") return { etapa, actores: await this.#caras(codigo, progreso.orden) };
    if (etapa === "convencio" || etapa === "memoria") return { etapa, videos: await this.#miniaturas(progreso.orden) };
    if (etapa === "revelacion") {
      return { etapa, segundos_transcurridos: Math.max(0, Math.floor((ahoraMs - progreso.actualizadoEnMs) / 1000)) };
    }
    return { etapa };
  }

  async #caras(codigo: string, orden: string[]): Promise<{ id: string; cara_url: string }[]> {
    const ids = await OrdenEstable.ordenar(codigo, actoresDe(await this.#videos.enOrden(orden)));
    const actores = await this.#actores.enOrden(ids);
    const urls = await this.#almacen.firmar("caras", actores.map((a) => a.cara_ruta));
    return actores.map((a) => ({ id: a.id, cara_url: urls.get(a.cara_ruta)! }));
  }

  async #miniaturas(orden: string[]): Promise<{ id: string; miniatura_url: string }[]> {
    const videos = await this.#videos.enOrden(orden);
    if (videos.some((v) => !v.miniatura_ruta)) throw new ErrorControlado("video_sin_miniatura");
    const urls = await this.#almacen.firmar("miniaturas", videos.map((v) => v.miniatura_ruta as string));
    return videos.map((v) => ({ id: v.id, miniatura_url: urls.get(v.miniatura_ruta as string)! }));
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
