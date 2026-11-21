// Clasificación de los videos (tabla public.clasificacion_videos): origen ("real" o "ia") y tipo
// ("ingenieria_social" o "normal"). Sin acceso para anon ni authenticated: solo la clave de servicio, desde
// las funciones del administrador o para calcular el resultado. Nunca se devuelve a un participante.
// Ningún id ni valor va a los logs.
import { ErrorControlado } from "./entorno.ts";
import { PATRON_UUID } from "./progreso.ts";
import { ClienteRest } from "./supabase.ts";

const TABLA = "clasificacion_videos";

export const ORIGENES = ["real", "ia"] as const;
export const TIPOS = ["ingenieria_social", "normal"] as const;
export type Origen = typeof ORIGENES[number];
export type Tipo = typeof TIPOS[number];
export type Clasificacion = { video_id: string; origen: Origen; tipo: Tipo };

export class ValidadorDeClasificacion {
  static esOrigen(valor: unknown): valor is Origen {
    return typeof valor === "string" && (ORIGENES as readonly string[]).includes(valor);
  }

  static esTipo(valor: unknown): valor is Tipo {
    return typeof valor === "string" && (TIPOS as readonly string[]).includes(valor);
  }

  /** La clasificación normalizada, o null si algún valor no es exactamente uno de los permitidos. */
  static validar(videoId: unknown, origen: unknown, tipo: unknown): Clasificacion | null {
    if (typeof videoId !== "string" || !PATRON_UUID.test(videoId)) return null;
    if (!ValidadorDeClasificacion.esOrigen(origen) || !ValidadorDeClasificacion.esTipo(tipo)) return null;
    return { video_id: videoId.toLowerCase(), origen, tipo };
  }
}

export class RegistroDeClasificacion {
  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  static #interpretar(f: Record<string, unknown>): Clasificacion {
    const c = ValidadorDeClasificacion.validar(f.video_id, f.origen, f.tipo);
    if (!c) throw new ErrorControlado("clasificacion_ilegible");
    return c;
  }

  async listar(): Promise<Clasificacion[]> {
    const filas = await this.#servicio.consultar(TABLA, { select: "video_id,origen,tipo", order: "video_id.asc" });
    return filas.map(RegistroDeClasificacion.#interpretar);
  }

  /** Map(video_id → origen) de los videos de `ids` que tienen clasificación. */
  async origenes(ids: string[]): Promise<Map<string, Origen>> {
    if (!ids.length) return new Map();
    if (!ids.every((id) => PATRON_UUID.test(id))) throw new ErrorControlado("clasificacion_ids_ilegibles");
    const filas = await this.#servicio.consultar(TABLA, { select: "video_id,origen,tipo", video_id: `in.(${ids.join(",")})` });
    return new Map(filas.map(RegistroDeClasificacion.#interpretar).map((c) => [c.video_id, c.origen]));
  }

  /** Inserta o actualiza la clasificación de un video (clave video_id). */
  async fijar(c: Clasificacion, ahoraMs: number): Promise<void> {
    await this.#servicio.insertarOActualizar(TABLA, { ...c, actualizado_en: new Date(ahoraMs).toISOString() }, "video_id");
  }
}
