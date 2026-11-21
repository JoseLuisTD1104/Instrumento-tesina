// Progreso del participante en la prueba (tabla public.progreso_participante). La etapa, el orden de la
// fase a ciegas y la posición viven solo aquí: el navegador nunca recibe el orden completo ni lo guarda.
// Solo la clave de servicio accede a la tabla. Ningún código ni id de video va a los logs.
import { ErrorControlado } from "./entorno.ts";
import { ClienteRest } from "./supabase.ts";

const TABLA = "progreso_participante";

export const ETAPAS = [
  "instruccion", "ciega", "conoce", "convencio", "revelacion", "memoria", "evaluacion", "exposicion", "resultado", "fin",
] as const;
export type Etapa = typeof ETAPAS[number];

export const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** actualizadoEnMs: cuándo cambió por última vez (en la práctica, cuándo entró a la etapa actual). */
export type Progreso = { etapa: Etapa; orden: string[]; posicion: number; actualizadoEnMs: number };

/** Fisher-Yates con crypto.getRandomValues. Cada índice se elige por rechazo: sin sesgo de módulo. */
export class MezcladorSinSesgo {
  static #indice(n: number): number {
    const limite = Math.floor(0x1_0000_0000 / n) * n;
    const valor = new Uint32Array(1);
    do crypto.getRandomValues(valor); while (valor[0] >= limite);
    return valor[0] % n;
  }

  static mezclar<T>(lista: readonly T[]): T[] {
    const r = [...lista];
    for (let i = r.length - 1; i > 0; i--) {
      const j = MezcladorSinSesgo.#indice(i + 1);
      [r[i], r[j]] = [r[j], r[i]];
    }
    return r;
  }
}

/** Qué videos de la fase a ciegas puede ver el participante: el actual y el siguiente, nunca otros. */
export class FaseCiega {
  static VISIBLES = 2;

  static actual(p: Progreso): string | null {
    return p.etapa === "ciega" ? p.orden[p.posicion] ?? null : null;
  }

  static visibles(p: Progreso): string[] {
    return p.etapa === "ciega" ? p.orden.slice(p.posicion, p.posicion + FaseCiega.VISIBLES) : [];
  }
}

export class RegistroDeProgreso {
  static MAX_VIDEOS = 50;
  static COLUMNAS = "etapa,orden_ciego,posicion_ciega,actualizado_en";

  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  /** Ids de los videos publicados, mezclados en el servidor. Lanza si no hay ninguno o pasan del máximo. */
  async ordenAleatorio(): Promise<string[]> {
    const filas = await this.#servicio.consultar("videos", { select: "id", publicado: "eq.true", order: "id.asc" });
    const ids = filas.map((f) => f.id);
    if (!ids.every((id): id is string => typeof id === "string" && PATRON_UUID.test(id))) throw new ErrorControlado("videos_ids_ilegibles");
    if (ids.length < 1 || ids.length > RegistroDeProgreso.MAX_VIDEOS) throw new ErrorControlado("videos_publicados_fuera_de_rango");
    return MezcladorSinSesgo.mezclar(ids.map((id) => id.toLowerCase()));
  }

  async crear(codigo: string, orden: string[]): Promise<void> {
    if (orden.length < 1 || orden.length > RegistroDeProgreso.MAX_VIDEOS) throw new ErrorControlado("orden_fuera_de_rango");
    await this.#servicio.insertar(TABLA, { codigo_participante: codigo, etapa: "instruccion", orden_ciego: orden, posicion_ciega: 0 });
  }

  async borrar(codigo: string): Promise<void> {
    await this.#servicio.borrar(TABLA, { codigo_participante: `eq.${codigo}` });
  }

  /** El progreso del participante, o null si no tiene fila. Lanza si la fila es ilegible. */
  async leer(codigo: string): Promise<Progreso | null> {
    const filas = await this.#servicio.consultar(TABLA, { select: RegistroDeProgreso.COLUMNAS, codigo_participante: `eq.${codigo}`, limit: "2" });
    if (filas.length === 0) return null;
    if (filas.length !== 1) throw new ErrorControlado("progreso_duplicado");
    return RegistroDeProgreso.#interpretar(filas[0]);
  }

  /**
   * Cambia la etapa solo si sigue siendo `desde` (actualización condicionada). true si cambió.
   * `condiciones` agrega filtros de PostgREST y `extra`, columnas que se guardan en la misma actualización.
   */
  async cambiarEtapa(codigo: string, desde: Etapa, hacia: Etapa, ahoraMs: number,
    { condiciones = {}, extra = {} }: { condiciones?: Record<string, string>; extra?: Record<string, unknown> } = {}): Promise<boolean> {
    const filas = await this.#servicio.actualizar(TABLA,
      { ...condiciones, codigo_participante: `eq.${codigo}`, etapa: `eq.${desde}`, select: "etapa" },
      { ...extra, etapa: hacia, actualizado_en: new Date(ahoraMs).toISOString() });
    return filas.length === 1;
  }

  /**
   * Avanza la posición de la fase a ciegas en 1, solo si sigue en `posicionAnterior` y en etapa "ciega":
   * dos peticiones simultáneas no pueden avanzar dos veces. Al llegar al final pasa a "conoce".
   * Devuelve el progreso nuevo, o null si la condición ya no se cumplía.
   */
  async avanzarCiega(codigo: string, posicionAnterior: number, total: number, ahoraMs: number): Promise<Progreso | null> {
    const siguiente = posicionAnterior + 1;
    const filas = await this.#servicio.actualizar(TABLA,
      { codigo_participante: `eq.${codigo}`, etapa: "eq.ciega", posicion_ciega: `eq.${posicionAnterior}`, select: RegistroDeProgreso.COLUMNAS },
      { posicion_ciega: siguiente, etapa: siguiente >= total ? "conoce" : "ciega", actualizado_en: new Date(ahoraMs).toISOString() });
    if (filas.length === 0) return null;
    if (filas.length !== 1) throw new ErrorControlado("progreso_duplicado");
    return RegistroDeProgreso.#interpretar(filas[0]);
  }

  static #interpretar(fila: Record<string, unknown>): Progreso {
    const { etapa, orden_ciego: orden, posicion_ciega: posicion } = fila;
    const actualizadoEnMs = Date.parse(String(fila.actualizado_en ?? ""));
    if (!Number.isFinite(actualizadoEnMs)) throw new ErrorControlado("progreso_fecha_ilegible");
    if (typeof etapa !== "string" || !(ETAPAS as readonly string[]).includes(etapa)) throw new ErrorControlado("progreso_etapa_ilegible");
    if (!Array.isArray(orden) || orden.length < 1 || orden.length > RegistroDeProgreso.MAX_VIDEOS ||
        !orden.every((id) => typeof id === "string" && PATRON_UUID.test(id))) throw new ErrorControlado("progreso_orden_ilegible");
    if (typeof posicion !== "number" || !Number.isInteger(posicion) || posicion < 0 || posicion > orden.length) {
      throw new ErrorControlado("progreso_posicion_ilegible");
    }
    return { etapa: etapa as Etapa, orden: orden.map((id: string) => id.toLowerCase()), posicion, actualizadoEnMs };
  }
}
