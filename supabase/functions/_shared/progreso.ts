// Progreso del participante en la prueba (tabla public.progreso_participante). La etapa, el orden de la
// fase a ciegas, el de la evaluación y sus posiciones viven solo aquí: el navegador nunca recibe un orden
// completo ni lo guarda.
// Solo la clave de servicio accede a la tabla. Ningún código ni id de video va a los logs.
import { ErrorControlado } from "./entorno.ts";
import { ClienteRest } from "./supabase.ts";

const TABLA = "progreso_participante";

export const ETAPAS = [
  "instruccion", "ciega", "conoce", "convencio", "revelacion", "memoria", "evaluacion", "exposicion", "resultado", "fin",
] as const;
export type Etapa = typeof ETAPAS[number];

export const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * orden/posicion: fase a ciegas. ordenEvaluacion: los mismos ids en otro orden (null hasta entrar a la
 * evaluación) y posicionEvaluacion. actualizadoEnMs: cuándo cambió por última vez (en la práctica, cuándo
 * entró a la etapa actual).
 */
export type Progreso = {
  etapa: Etapa; orden: string[]; posicion: number;
  ordenEvaluacion: string[] | null; posicionEvaluacion: number; actualizadoEnMs: number;
};

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

  /** Mezcla hasta que el orden sea distinto del original (con 2 o más elementos; con 1 no hay otro orden). */
  static mezclarDistinto<T>(lista: readonly T[]): T[] {
    if (lista.length < 2) return [...lista];
    let r: T[];
    do r = MezcladorSinSesgo.mezclar(lista); while (r.every((v, i) => v === lista[i]));
    return r;
  }
}

type Recorrido = { orden: string[]; posicion: number };

/**
 * Una fase de videos de un solo sentido (a ciegas o evaluación). Qué videos puede ver el participante:
 * el actual y el siguiente de esa fase, nunca otros.
 */
export class FaseDeVideos {
  static VISIBLES = 2;
  static CIEGA = new FaseDeVideos("ciega", (p) => ({ orden: p.orden, posicion: p.posicion }));
  static EVALUACION = new FaseDeVideos("evaluacion", (p) => ({ orden: p.ordenEvaluacion ?? [], posicion: p.posicionEvaluacion }));

  readonly etapa: Etapa;
  #recorrido: (p: Progreso) => Recorrido;

  constructor(etapa: Etapa, recorrido: (p: Progreso) => Recorrido) {
    this.etapa = etapa;
    this.#recorrido = recorrido;
  }

  /** La fase de la etapa actual, o null si la etapa no es de videos. */
  static de(p: Progreso): FaseDeVideos | null {
    return [FaseDeVideos.CIEGA, FaseDeVideos.EVALUACION].find((f) => f.etapa === p.etapa) ?? null;
  }

  actual(p: Progreso): string | null {
    if (p.etapa !== this.etapa) return null;
    const { orden, posicion } = this.#recorrido(p);
    return orden[posicion] ?? null;
  }

  visibles(p: Progreso): string[] {
    if (p.etapa !== this.etapa) return [];
    const { orden, posicion } = this.#recorrido(p);
    return orden.slice(posicion, posicion + FaseDeVideos.VISIBLES);
  }

  /** Posición y total de esta fase (lo único que se informa al participante). */
  avance(p: Progreso): { posicion: number; total: number } {
    const { orden, posicion } = this.#recorrido(p);
    return { posicion, total: orden.length };
  }
}

export const FaseCiega = FaseDeVideos.CIEGA;

export class RegistroDeProgreso {
  static MAX_VIDEOS = 50;
  static COLUMNAS = "etapa,orden_ciego,posicion_ciega,orden_evaluacion,posicion_evaluacion,actualizado_en";

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

  /** Avanza la fase a ciegas en 1 (ver #avanzar); al llegar al final pasa a "conoce". */
  async avanzarCiega(codigo: string, posicionAnterior: number, total: number, ahoraMs: number): Promise<Progreso | null> {
    return await this.#avanzar(codigo, { etapa: "ciega", columna: "posicion_ciega", final: "conoce" }, posicionAnterior, total, ahoraMs);
  }

  /** Avanza la evaluación en 1 (ver #avanzar); al llegar al final pasa a "exposicion". */
  async avanzarEvaluacion(codigo: string, posicionAnterior: number, total: number, ahoraMs: number): Promise<Progreso | null> {
    return await this.#avanzar(codigo, { etapa: "evaluacion", columna: "posicion_evaluacion", final: "exposicion" }, posicionAnterior, total, ahoraMs);
  }

  /**
   * Avanza la posición de una fase en 1, solo si sigue en `posicionAnterior` y en la etapa de esa fase:
   * dos peticiones simultáneas no pueden avanzar dos veces. Al llegar a `total` pasa a la etapa `final`.
   * Devuelve el progreso nuevo, o null si la condición ya no se cumplía.
   */
  async #avanzar(codigo: string, fase: { etapa: Etapa; columna: string; final: Etapa }, posicionAnterior: number,
    total: number, ahoraMs: number): Promise<Progreso | null> {
    const siguiente = posicionAnterior + 1;
    const filas = await this.#servicio.actualizar(TABLA,
      { codigo_participante: `eq.${codigo}`, etapa: `eq.${fase.etapa}`, [fase.columna]: `eq.${posicionAnterior}`, select: RegistroDeProgreso.COLUMNAS },
      { [fase.columna]: siguiente, etapa: siguiente >= total ? fase.final : fase.etapa, actualizado_en: new Date(ahoraMs).toISOString() });
    if (filas.length === 0) return null;
    if (filas.length !== 1) throw new ErrorControlado("progreso_duplicado");
    return RegistroDeProgreso.#interpretar(filas[0]);
  }

  static #ids(lista: unknown): lista is string[] {
    return Array.isArray(lista) && lista.length >= 1 && lista.length <= RegistroDeProgreso.MAX_VIDEOS &&
      lista.every((id) => typeof id === "string" && PATRON_UUID.test(id));
  }

  static #posicion(valor: unknown, largo: number): valor is number {
    return typeof valor === "number" && Number.isInteger(valor) && valor >= 0 && valor <= largo;
  }

  static #interpretar(fila: Record<string, unknown>): Progreso {
    const { etapa, orden_ciego: orden, posicion_ciega: posicion, orden_evaluacion: ordenEval, posicion_evaluacion: posicionEval } = fila;
    const actualizadoEnMs = Date.parse(String(fila.actualizado_en ?? ""));
    if (!Number.isFinite(actualizadoEnMs)) throw new ErrorControlado("progreso_fecha_ilegible");
    if (typeof etapa !== "string" || !(ETAPAS as readonly string[]).includes(etapa)) throw new ErrorControlado("progreso_etapa_ilegible");
    if (!RegistroDeProgreso.#ids(orden)) throw new ErrorControlado("progreso_orden_ilegible");
    if (!RegistroDeProgreso.#posicion(posicion, orden.length)) throw new ErrorControlado("progreso_posicion_ilegible");
    // El orden de la evaluación, si ya existe, tiene los mismos videos que el de la fase a ciegas.
    const normalizar = (ids: string[]) => ids.map((id) => id.toLowerCase());
    let ordenEvaluacion: string[] | null = null;
    if (ordenEval != null) {
      if (!RegistroDeProgreso.#ids(ordenEval)) throw new ErrorControlado("progreso_orden_evaluacion_ilegible");
      ordenEvaluacion = normalizar(ordenEval);
      const ciegos = new Set(normalizar(orden));
      if (ordenEvaluacion.length !== ciegos.size || new Set(ordenEvaluacion).size !== ciegos.size || !ordenEvaluacion.every((id) => ciegos.has(id))) {
        throw new ErrorControlado("progreso_orden_evaluacion_distinto");
      }
    }
    if (!RegistroDeProgreso.#posicion(posicionEval, ordenEvaluacion?.length ?? 0)) throw new ErrorControlado("progreso_posicion_evaluacion_ilegible");
    if (etapa === "evaluacion" && !ordenEvaluacion) throw new ErrorControlado("progreso_sin_orden_evaluacion");
    return {
      etapa: etapa as Etapa, orden: normalizar(orden), posicion, ordenEvaluacion, posicionEvaluacion: posicionEval, actualizadoEnMs,
    };
  }
}
