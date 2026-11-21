// Evaluación de los videos (tabla public.respuestas_evaluacion): la respuesta en la escala de 1 a 6 de cada
// video, ligada solo al código anónimo, que pone el servidor. Solo la clave de servicio accede a la tabla.
// El resultado individual se calcula aquí y solo sale como { aciertos, total }: nunca el detalle por video,
// el origen ni el tipo. Ningún código, id ni respuesta va a los logs.
import { ErrorControlado } from "./entorno.ts";
import { type Origen } from "./clasificacion.ts";
import { PATRON_UUID } from "./progreso.ts";
import { ClienteRest } from "./supabase.ts";
import { type Visualizacion, ValidadorDeVisualizacion } from "./visualizaciones.ts";

const TABLA = "respuestas_evaluacion";

export type Evaluacion = { respuesta: number; visualizacion: Visualizacion };

/** Reglas exactas del cuerpo: respuesta (entero 1–6) y los campos de la visualización, ninguno de más. */
export class ValidadorDeEvaluacion {
  static MIN = 1;
  static MAX = 6;
  static CAMPOS = ["respuesta", ...ValidadorDeVisualizacion.CAMPOS];

  static validar(cuerpo: unknown): Evaluacion | null {
    if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) return null;
    const c = cuerpo as Record<string, unknown>;
    const claves = Object.keys(c);
    if (claves.length !== ValidadorDeEvaluacion.CAMPOS.length || !claves.every((k) => ValidadorDeEvaluacion.CAMPOS.includes(k))) return null;
    const { respuesta, ...resto } = c;
    if (typeof respuesta !== "number" || !Number.isInteger(respuesta) ||
        respuesta < ValidadorDeEvaluacion.MIN || respuesta > ValidadorDeEvaluacion.MAX) return null;
    const visualizacion = ValidadorDeVisualizacion.validar(resto);
    return visualizacion ? { respuesta, visualizacion } : null;
  }
}

export class RegistroDeEvaluaciones {
  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  /** Lanza ErrorConflicto si ese video ya tiene respuesta (clave codigo_participante, video_id). */
  async insertar(codigo: string, videoId: string, respuesta: number, posicion: number, ahoraMs: number): Promise<void> {
    await this.#servicio.insertar(TABLA, {
      codigo_participante: codigo, video_id: videoId, respuesta, posicion, creado_en: new Date(ahoraMs).toISOString(),
    });
  }

  /** Deshace una inserción si después falló la otra o no se pudo avanzar. */
  async borrar(codigo: string, videoId: string): Promise<void> {
    await this.#servicio.borrar(TABLA, { codigo_participante: `eq.${codigo}`, video_id: `eq.${videoId}` });
  }

  /** Map(video_id → respuesta) del participante. Lanza si alguna fila es ilegible. */
  async respuestas(codigo: string): Promise<Map<string, number>> {
    const filas = await this.#servicio.consultar(TABLA, { select: "video_id,respuesta", codigo_participante: `eq.${codigo}` });
    const respuestas = new Map<string, number>();
    for (const f of filas) {
      const id = typeof f.video_id === "string" && PATRON_UUID.test(f.video_id) ? f.video_id.toLowerCase() : null;
      const r = f.respuesta;
      if (!id || typeof r !== "number" || !Number.isInteger(r) || r < ValidadorDeEvaluacion.MIN || r > ValidadorDeEvaluacion.MAX) {
        throw new ErrorControlado("respuesta_evaluacion_ilegible");
      }
      respuestas.set(id, r);
    }
    return respuestas;
  }
}

/**
 * Resultado individual: de los videos del orden de evaluación que tienen clasificación, es acierto si el
 * origen es "ia" y la respuesta es 4 o más, o si es "real" y la respuesta es 3 o menos. total = cuántos
 * videos tienen clasificación. Un video clasificado sin respuesta cuenta en el total, no como acierto.
 */
export class CalculadoraDeResultado {
  static esAcierto(origen: Origen, respuesta: number | undefined): boolean {
    if (respuesta === undefined) return false;
    return origen === "ia" ? respuesta >= 4 : respuesta <= 3;
  }

  static calcular(orden: string[], respuestas: Map<string, number>, origenes: Map<string, Origen>): { aciertos: number; total: number } {
    let aciertos = 0;
    let total = 0;
    for (const id of orden) {
      const origen = origenes.get(id);
      if (!origen) continue;
      total++;
      if (CalculadoraDeResultado.esAcierto(origen, respuestas.get(id))) aciertos++;
    }
    return { aciertos, total };
  }
}
