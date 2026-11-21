// Visualizaciones de cada video (tabla public.visualizaciones): tiempo en pantalla, tiempo reproduciéndose
// y si llegó al final. El código anónimo y la posición los pone el servidor; nunca vienen del cliente.
import { ClienteRest } from "./supabase.ts";
import { PATRON_UUID } from "./progreso.ts";

export type Visualizacion = { video_id: string; tiempo_pantalla_ms: number; reproduccion_ms: number; completo: boolean };
export type Fase = "ciega" | "evaluacion";

/** Reglas exactas del cuerpo: los cuatro campos, ninguno de más, en rango. */
export class ValidadorDeVisualizacion {
  static CAMPOS = ["video_id", "tiempo_pantalla_ms", "reproduccion_ms", "completo"];
  static MAX_MS = 3_600_000;

  static #ms(valor: unknown): valor is number {
    return typeof valor === "number" && Number.isInteger(valor) && valor >= 0 && valor <= ValidadorDeVisualizacion.MAX_MS;
  }

  static validar(cuerpo: unknown): Visualizacion | null {
    if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) return null;
    const c = cuerpo as Record<string, unknown>;
    const claves = Object.keys(c);
    if (claves.length !== ValidadorDeVisualizacion.CAMPOS.length || !claves.every((k) => ValidadorDeVisualizacion.CAMPOS.includes(k))) return null;
    const { video_id, tiempo_pantalla_ms, reproduccion_ms, completo } = c;
    if (typeof video_id !== "string" || !PATRON_UUID.test(video_id)) return null;
    if (!ValidadorDeVisualizacion.#ms(tiempo_pantalla_ms) || !ValidadorDeVisualizacion.#ms(reproduccion_ms)) return null;
    if (typeof completo !== "boolean") return null;
    return { video_id: video_id.toLowerCase(), tiempo_pantalla_ms, reproduccion_ms, completo };
  }
}

export class RegistroDeVisualizaciones {
  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  /** Lanza ErrorConflicto si ya existe la fila (codigo, video, fase). */
  async insertar(codigo: string, v: Visualizacion, fase: Fase, posicion: number, ahoraMs: number): Promise<void> {
    await this.#servicio.insertar("visualizaciones", {
      codigo_participante: codigo, ...v, fase, posicion, creado_en: new Date(ahoraMs).toISOString(),
    });
  }

  /** Deshace una inserción si después no se pudo avanzar la posición. */
  async borrar(codigo: string, videoId: string, fase: Fase): Promise<void> {
    await this.#servicio.borrar("visualizaciones", { codigo_participante: `eq.${codigo}`, video_id: `eq.${videoId}`, fase: `eq.${fase}` });
  }
}
