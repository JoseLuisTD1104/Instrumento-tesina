// Respuestas de las etapas posteriores a la fase a ciegas: reconocimiento de actores
// (public.respuestas_conoce), "¿harías lo que te pide?" y "¿cuáles eran deepfake?" (public.respuestas_video).
// Siempre con ids fijos (actor o video), nunca con lo que muestre la pantalla; el código anónimo lo pone el
// servidor. Solo la clave de servicio accede a las tablas. Ningún código ni id va a los logs.
import { type Etapa, PATRON_UUID } from "./progreso.ts";
import { ClienteRest } from "./supabase.ts";

export type Pregunta = "haria" | "deepfake";
export type Respuesta = { etapa: Etapa; marcados: string[]; ninguno: boolean };

/** Etapas que se contestan con una selección, y la que sigue a cada una. */
export const SIGUIENTE_ETAPA: Partial<Record<Etapa, Etapa>> = {
  conoce: "convencio", convencio: "revelacion", revelacion: "memoria", memoria: "evaluacion",
};
export const PREGUNTA_DE_ETAPA: Partial<Record<Etapa, Pregunta>> = { convencio: "haria", memoria: "deepfake" };

/** Reglas exactas del cuerpo. La pertenencia de los ids a este participante se revisa aparte. */
export class ValidadorDeRespuesta {
  static MAX_MARCADOS = 50;

  /** La respuesta normalizada si cumple las reglas para la etapa actual; null si no. */
  static validar(cuerpo: unknown, etapaActual: Etapa): Respuesta | null {
    if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) return null;
    const c = cuerpo as Record<string, unknown>;
    if (c.etapa !== etapaActual || !(etapaActual in SIGUIENTE_ETAPA)) return null;
    const claves = Object.keys(c);
    // La revelación solo confirma: exactamente { etapa }.
    if (etapaActual === "revelacion") return claves.length === 1 ? { etapa: etapaActual, marcados: [], ninguno: false } : null;
    if (claves.length !== 3 || !["etapa", "marcados", "ninguno"].every((k) => claves.includes(k))) return null;
    const { marcados, ninguno } = c;
    if (!Array.isArray(marcados) || marcados.length > ValidadorDeRespuesta.MAX_MARCADOS || typeof ninguno !== "boolean") return null;
    if (!marcados.every((id) => typeof id === "string" && PATRON_UUID.test(id))) return null;
    const normalizados = (marcados as string[]).map((id) => id.toLowerCase());
    if (new Set(normalizados).size !== normalizados.length) return null;
    if (ninguno !== (normalizados.length === 0)) return null; // vacío ⇔ "Ninguno"
    return { etapa: etapaActual, marcados: normalizados, ninguno };
  }

  /** true si todos los marcados están entre los permitidos. */
  static pertenecen(marcados: string[], permitidos: string[]): boolean {
    const conjunto = new Set(permitidos);
    return marcados.every((id) => conjunto.has(id));
  }
}

export class RegistroDeRespuestas {
  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  /** Una fila por actor (conoce true o false), en una sola inserción. Lanza ErrorConflicto si ya había. */
  async insertarConoce(codigo: string, actores: string[], marcados: string[], ahoraMs: number): Promise<void> {
    const si = new Set(marcados);
    const creado = new Date(ahoraMs).toISOString();
    await this.#servicio.insertar("respuestas_conoce",
      actores.map((actor_id) => ({ codigo_participante: codigo, actor_id, conoce: si.has(actor_id), creado_en: creado })));
  }

  async borrarConoce(codigo: string): Promise<void> {
    await this.#servicio.borrar("respuestas_conoce", { codigo_participante: `eq.${codigo}` });
  }

  /** Una fila por video del orden (marcado true o false, posicion = lugar en el orden, desde 1). */
  async insertarVideos(codigo: string, orden: string[], marcados: string[], pregunta: Pregunta, ahoraMs: number): Promise<void> {
    const si = new Set(marcados);
    const creado = new Date(ahoraMs).toISOString();
    await this.#servicio.insertar("respuestas_video", orden.map((video_id, i) => ({
      codigo_participante: codigo, video_id, pregunta, marcado: si.has(video_id), posicion: i + 1, creado_en: creado,
    })));
  }

  async borrarVideos(codigo: string, pregunta: Pregunta): Promise<void> {
    await this.#servicio.borrar("respuestas_video", { codigo_participante: `eq.${codigo}`, pregunta: `eq.${pregunta}` });
  }
}
