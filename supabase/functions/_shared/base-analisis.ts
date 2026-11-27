// Base de análisis de «Resultados» (parte 1): una fila por participante × video con al menos una de las tres
// respuestas, unida a la clasificación del video, al perfil del participante y a las marcas de exclusión.
// Solo lee, con la clave de servicio, y solo desde admin-resultados. Nunca lee public.participantes (nombre,
// matrícula): la carrera sale de perfil_participante. No calcula aciertos ni índices: eso es de la parte 2.
// Ningún código, id ni respuesta va a los logs.
//
// Tablas que lee (todas por lotes de 1000, sin depender de cuántos videos haya):
//   respuestas_video        (codigo_participante, video_id, pregunta "deepfake"|"haria", marcado, creado_en)
//   respuestas_evaluacion   (codigo_participante, video_id, respuesta 1–6, creado_en)
//   respuestas_conoce       (codigo_participante, actor_id, conoce, creado_en)
//   videos                  (id, numero_video, actor_id)
//   clasificacion_videos    (video_id, origen, tipo)
//   perfil_participante     (codigo_participante, carrera, edad, semestre, deepfakes_previos)
//   progreso_participante   (codigo_participante, etapa)
//   retiros_participante    (codigo_participante)  ← tabla nueva; ver el SQL que acompaña a esta función.
import { ErrorControlado } from "./entorno.ts";
import { type Origen, type Tipo, ValidadorDeClasificacion } from "./clasificacion.ts";
import { GeneradorCodigoParticipante } from "./participantes.ts";
import { type Etapa, ETAPAS, PATRON_UUID } from "./progreso.ts";
import { ClienteRest } from "./supabase.ts";

/** Versión del contrato de la respuesta. Sube solo si cambia un campo, su tipo o su significado. */
export const VERSION_BASE = 1;

export type FilaBase = {
  codigo_participante: string;
  numero_video: number | null;
  origen: Origen | null;
  tipo: Tipo | null;
  marco_deepfake_p8: boolean | null;
  obedeceria: boolean | null;
  escala_p9: number | null;
  carrera: string | null;
  edad: number | null;
  semestre: number | null;
  deepfakes_previos: boolean | null;
  excl_conoce_actor: boolean;
  excl_sesion_incompleta: boolean;
  excl_retiro: boolean;
};

export type ResumenBase = {
  participantes: number;
  participantes_registrados: number;
  filas: number;
  videos: number;
  videos_sin_clasificar: number;
  numeros_sin_clasificar: number[];
  filas_sin_numero_video: number;
};

export type BaseDeAnalisis = { version: number; generado_en: string; resumen: ResumenBase; filas: FilaBase[] };

type Fila = Record<string, unknown>;
type RespuestaVideo = { codigo: string; video: string; pregunta: "deepfake" | "haria"; marcado: boolean };
type Evaluacion = { codigo: string; video: string; respuesta: number };
type Conoce = { codigo: string; actor: string; conoce: boolean };
type Video = { numero: number | null; actor: string | null };
type Perfil = { carrera: string | null; edad: number | null; semestre: number | null; deepfakes_previos: boolean | null };

/** Todo lo que la base necesita, ya leído y validado. */
export type Lecturas = {
  respuestasVideo: RespuestaVideo[];
  evaluaciones: Evaluacion[];
  conoce: Conoce[];
  videos: Map<string, Video>;
  clasificacion: Map<string, { origen: Origen; tipo: Tipo }>;
  perfiles: Map<string, Perfil>;
  etapas: Map<string, Etapa>;
  retiros: Set<string>;
  participantesRegistrados: number;
};

const TABLA_RETIROS = "retiros_participante";

/** Lee las tablas por lotes y valida cada fila; una fila ilegible detiene todo (falla cerrada). */
export class LectorDeResultados {
  static LOTE = 1000; // máximo de filas por consulta de PostgREST
  static MAX_FILAS = 200_000; // tope de seguridad de memoria por tabla
  static CODIGOS_POR_CONSULTA = 100; // para que la URL de in.(…) no crezca sin límite

  #servicio: ClienteRest;
  #lote: number;

  constructor(servicio: ClienteRest, lote = LectorDeResultados.LOTE) {
    this.#servicio = servicio;
    this.#lote = lote;
  }

  async leerTodo(): Promise<Lecturas> {
    const [respuestasVideo, evaluaciones, conoce, videos, clasificacion, retiros, participantesRegistrados] = await Promise.all([
      this.#respuestasVideo(), this.#evaluaciones(), this.#conoce(), this.#videos(), this.#clasificacion(), this.#retiros(),
      this.#todas("perfil_participante", "codigo_participante", ["codigo_participante"]).then((f) => f.length),
    ]);
    const codigos = [...new Set([...respuestasVideo, ...evaluaciones].map((r) => r.codigo))].sort();
    const [perfiles, etapas] = await Promise.all([this.#perfiles(codigos), this.#etapas(codigos)]);
    return { respuestasVideo, evaluaciones, conoce, videos, clasificacion, perfiles, etapas, retiros, participantesRegistrados };
  }

  /**
   * Todas las filas de una tabla, de `lote` en `lote`. El orden empieza por creado_en (las filas nuevas
   * quedan al final y no mueven las ya leídas) y sigue con la clave para no tener empates.
   */
  async #todas(tabla: string, select: string, orden: string[]): Promise<Fila[]> {
    const filas: Fila[] = [];
    for (let desde = 0; ; desde += this.#lote) {
      const lote = await this.#servicio.consultar(tabla, {
        select, order: orden.map((k) => `${k}.asc`).join(","), limit: String(this.#lote), offset: String(desde),
      });
      filas.push(...lote);
      if (filas.length > LectorDeResultados.MAX_FILAS) throw new ErrorControlado("demasiadas_filas");
      if (lote.length < this.#lote) return filas;
    }
  }

  /** Filas de los participantes indicados, en grupos de códigos y cada grupo por lotes. */
  async #deCodigos(tabla: string, select: string, codigos: string[]): Promise<Fila[]> {
    const filas: Fila[] = [];
    for (let i = 0; i < codigos.length; i += LectorDeResultados.CODIGOS_POR_CONSULTA) {
      const grupo = codigos.slice(i, i + LectorDeResultados.CODIGOS_POR_CONSULTA);
      for (let desde = 0; ; desde += this.#lote) {
        const lote = await this.#servicio.consultar(tabla, {
          select, codigo_participante: `in.(${grupo.join(",")})`, order: "codigo_participante.asc",
          limit: String(this.#lote), offset: String(desde),
        });
        filas.push(...lote);
        if (lote.length < this.#lote) break;
      }
    }
    return filas;
  }

  static #codigo(v: unknown, etiqueta: string): string {
    if (typeof v !== "string" || !GeneradorCodigoParticipante.PATRON.test(v)) throw new ErrorControlado(`${etiqueta}_codigo_ilegible`);
    return v;
  }

  static #uuid(v: unknown, etiqueta: string): string {
    if (typeof v !== "string" || !PATRON_UUID.test(v)) throw new ErrorControlado(`${etiqueta}_id_ilegible`);
    return v.toLowerCase();
  }

  static #entero(v: unknown, min: number, max: number): number | null {
    if (v == null) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new ErrorControlado("entero_ilegible");
    return v;
  }

  static #booleano(v: unknown, etiqueta: string): boolean {
    if (typeof v !== "boolean") throw new ErrorControlado(`${etiqueta}_booleano_ilegible`);
    return v;
  }

  /** Lanza si una clave aparece dos veces: un lote se leyó dos veces o la tabla no tiene la clave que se supone. */
  static #sinDuplicados<T>(lista: T[], clave: (x: T) => string, etiqueta: string): T[] {
    const vistas = new Set<string>();
    for (const x of lista) {
      const k = clave(x);
      if (vistas.has(k)) throw new ErrorControlado(`${etiqueta}_duplicado`);
      vistas.add(k);
    }
    return lista;
  }

  async #respuestasVideo(): Promise<RespuestaVideo[]> {
    const filas = await this.#todas("respuestas_video", "codigo_participante,video_id,pregunta,marcado",
      ["creado_en", "codigo_participante", "video_id", "pregunta"]);
    const lista = filas.map((f) => {
      if (f.pregunta !== "deepfake" && f.pregunta !== "haria") throw new ErrorControlado("respuestas_video_pregunta_ilegible");
      return {
        codigo: LectorDeResultados.#codigo(f.codigo_participante, "respuestas_video"),
        video: LectorDeResultados.#uuid(f.video_id, "respuestas_video"),
        pregunta: f.pregunta as "deepfake" | "haria",
        marcado: LectorDeResultados.#booleano(f.marcado, "respuestas_video"),
      };
    });
    return LectorDeResultados.#sinDuplicados(lista, (r) => `${r.codigo}|${r.video}|${r.pregunta}`, "respuestas_video");
  }

  async #evaluaciones(): Promise<Evaluacion[]> {
    const filas = await this.#todas("respuestas_evaluacion", "codigo_participante,video_id,respuesta",
      ["creado_en", "codigo_participante", "video_id"]);
    const lista = filas.map((f) => {
      const respuesta = LectorDeResultados.#entero(f.respuesta, 1, 6);
      if (respuesta === null) throw new ErrorControlado("respuestas_evaluacion_ilegible");
      return {
        codigo: LectorDeResultados.#codigo(f.codigo_participante, "respuestas_evaluacion"),
        video: LectorDeResultados.#uuid(f.video_id, "respuestas_evaluacion"),
        respuesta,
      };
    });
    return LectorDeResultados.#sinDuplicados(lista, (r) => `${r.codigo}|${r.video}`, "respuestas_evaluacion");
  }

  async #conoce(): Promise<Conoce[]> {
    const filas = await this.#todas("respuestas_conoce", "codigo_participante,actor_id,conoce",
      ["creado_en", "codigo_participante", "actor_id"]);
    const lista = filas.map((f) => ({
      codigo: LectorDeResultados.#codigo(f.codigo_participante, "respuestas_conoce"),
      actor: LectorDeResultados.#uuid(f.actor_id, "respuestas_conoce"),
      conoce: LectorDeResultados.#booleano(f.conoce, "respuestas_conoce"),
    }));
    return LectorDeResultados.#sinDuplicados(lista, (r) => `${r.codigo}|${r.actor}`, "respuestas_conoce");
  }

  async #videos(): Promise<Map<string, Video>> {
    const filas = await this.#todas("videos", "id,numero_video,actor_id", ["id"]);
    const videos = new Map<string, Video>();
    for (const f of filas) {
      const id = LectorDeResultados.#uuid(f.id, "videos");
      if (videos.has(id)) throw new ErrorControlado("videos_duplicado");
      const numero = LectorDeResultados.#entero(f.numero_video, 1, 1_000_000);
      const actor = f.actor_id == null ? null : LectorDeResultados.#uuid(f.actor_id, "videos_actor");
      videos.set(id, { numero, actor });
    }
    return videos;
  }

  async #clasificacion(): Promise<Map<string, { origen: Origen; tipo: Tipo }>> {
    const filas = await this.#todas("clasificacion_videos", "video_id,origen,tipo", ["video_id"]);
    const mapa = new Map<string, { origen: Origen; tipo: Tipo }>();
    for (const f of filas) {
      const c = ValidadorDeClasificacion.validar(f.video_id, f.origen, f.tipo);
      if (!c || mapa.has(c.video_id)) throw new ErrorControlado("clasificacion_ilegible");
      mapa.set(c.video_id, { origen: c.origen, tipo: c.tipo });
    }
    return mapa;
  }

  async #perfiles(codigos: string[]): Promise<Map<string, Perfil>> {
    const filas = await this.#deCodigos("perfil_participante", "codigo_participante,carrera,edad,semestre,deepfakes_previos", codigos);
    const mapa = new Map<string, Perfil>();
    for (const f of filas) {
      const codigo = LectorDeResultados.#codigo(f.codigo_participante, "perfil");
      if (mapa.has(codigo)) throw new ErrorControlado("perfil_duplicado");
      if (f.carrera != null && typeof f.carrera !== "string") throw new ErrorControlado("perfil_carrera_ilegible");
      if (f.deepfakes_previos != null && typeof f.deepfakes_previos !== "boolean") throw new ErrorControlado("perfil_previos_ilegible");
      mapa.set(codigo, {
        carrera: (f.carrera as string | null) ?? null,
        edad: LectorDeResultados.#entero(f.edad, 17, 99),
        semestre: LectorDeResultados.#entero(f.semestre, 1, 14),
        deepfakes_previos: (f.deepfakes_previos as boolean | null) ?? null,
      });
    }
    return mapa;
  }

  async #etapas(codigos: string[]): Promise<Map<string, Etapa>> {
    const filas = await this.#deCodigos("progreso_participante", "codigo_participante,etapa", codigos);
    const mapa = new Map<string, Etapa>();
    for (const f of filas) {
      const codigo = LectorDeResultados.#codigo(f.codigo_participante, "progreso");
      if (mapa.has(codigo)) throw new ErrorControlado("progreso_duplicado");
      if (typeof f.etapa !== "string" || !(ETAPAS as readonly string[]).includes(f.etapa)) throw new ErrorControlado("progreso_etapa_ilegible");
      mapa.set(codigo, f.etapa as Etapa);
    }
    return mapa;
  }

  async #retiros(): Promise<Set<string>> {
    let filas: Fila[];
    try {
      filas = await this.#todas(TABLA_RETIROS, "codigo_participante", ["codigo_participante"]);
    } catch (e) {
      // PostgREST responde 404 si la tabla aún no existe: sin ella la marca de retiro no es confiable.
      if (e instanceof ErrorControlado && e.message === `consulta_${TABLA_RETIROS}_404`) throw new ErrorControlado("falta_tabla_retiros");
      throw e;
    }
    return new Set(filas.map((f) => LectorDeResultados.#codigo(f.codigo_participante, "retiros")));
  }
}

/** Une las respuestas en una fila por participante × video y les pega video, clasificación y perfil. */
export class ArmadorDeBase {
  /** Filas sin marcas (todas en false); MarcadorDeExclusiones las enciende. Ordenadas por código y número de video. */
  static unir(l: Lecturas): { filas: FilaBase[]; videoDeFila: string[] } {
    const porClave = new Map<string, { codigo: string; video: string; p8: boolean | null; haria: boolean | null; p9: number | null }>();
    const fila = (codigo: string, video: string) => {
      const k = `${codigo}|${video}`;
      let f = porClave.get(k);
      if (!f) porClave.set(k, f = { codigo, video, p8: null, haria: null, p9: null });
      return f;
    };
    for (const r of l.respuestasVideo) {
      const f = fila(r.codigo, r.video);
      if (r.pregunta === "deepfake") f.p8 = r.marcado; else f.haria = r.marcado;
    }
    for (const e of l.evaluaciones) fila(e.codigo, e.video).p9 = e.respuesta;

    const unidas = [...porClave.values()].map((f) => {
      const numero = l.videos.get(f.video)?.numero ?? null;
      const clase = l.clasificacion.get(f.video) ?? null;
      const perfil = l.perfiles.get(f.codigo) ?? null;
      const salida: FilaBase = {
        codigo_participante: f.codigo,
        numero_video: numero,
        origen: clase?.origen ?? null,
        tipo: clase?.tipo ?? null,
        marco_deepfake_p8: f.p8,
        obedeceria: f.haria,
        escala_p9: f.p9,
        carrera: perfil?.carrera ?? null,
        edad: perfil?.edad ?? null,
        semestre: perfil?.semestre ?? null,
        deepfakes_previos: perfil?.deepfakes_previos ?? null,
        excl_conoce_actor: false,
        excl_sesion_incompleta: false,
        excl_retiro: false,
      };
      return { salida, video: f.video };
    });
    unidas.sort((a, b) => ArmadorDeBase.#comparar(a.salida, b.salida) || (a.video < b.video ? -1 : a.video > b.video ? 1 : 0));
    return { filas: unidas.map((u) => u.salida), videoDeFila: unidas.map((u) => u.video) };
  }

  /** Por código; después por número de video, con los nulos al final. */
  static #comparar(a: FilaBase, b: FilaBase): number {
    if (a.codigo_participante !== b.codigo_participante) return a.codigo_participante < b.codigo_participante ? -1 : 1;
    if (a.numero_video === b.numero_video) return 0;
    if (a.numero_video === null) return 1;
    if (b.numero_video === null) return -1;
    return a.numero_video - b.numero_video;
  }

  static resumen(filas: FilaBase[], participantesRegistrados: number): ResumenBase {
    const numeros = new Set<number>();
    const sinClasificar = new Set<number>();
    let sinNumero = 0;
    for (const f of filas) {
      if (f.numero_video === null) { sinNumero++; continue; }
      numeros.add(f.numero_video);
      if (f.origen === null || f.tipo === null) sinClasificar.add(f.numero_video);
    }
    return {
      participantes: new Set(filas.map((f) => f.codigo_participante)).size,
      participantes_registrados: participantesRegistrados,
      filas: filas.length,
      videos: numeros.size,
      videos_sin_clasificar: sinClasificar.size,
      numeros_sin_clasificar: [...sinClasificar].sort((a, b) => a - b),
      filas_sin_numero_video: sinNumero,
    };
  }
}

/** Enciende las tres marcas de exclusión. No quita ninguna fila: eso lo decide la interfaz. */
export class MarcadorDeExclusiones {
  /** Etapas posteriores a la evaluación (paso 9): quien está en una de ellas terminó la escala 1–6. */
  static ETAPAS_P9_TERMINADO: ReadonlySet<Etapa> = new Set<Etapa>(["exposicion", "resultado", "fin"]);

  static marcar(filas: FilaBase[], videoDeFila: string[], l: Lecturas): void {
    const conocidos = new Set(l.conoce.filter((c) => c.conoce).map((c) => `${c.codigo}|${c.actor}`));
    filas.forEach((f, i) => {
      const actor = l.videos.get(videoDeFila[i])?.actor ?? null;
      const etapa = l.etapas.get(f.codigo_participante);
      f.excl_conoce_actor = actor !== null && conocidos.has(`${f.codigo_participante}|${actor}`);
      f.excl_sesion_incompleta = etapa === undefined || !MarcadorDeExclusiones.ETAPAS_P9_TERMINADO.has(etapa);
      f.excl_retiro = l.retiros.has(f.codigo_participante);
    });
  }
}

/** Orquesta lector → armador → marcador. */
export class ConstructorDeBase {
  #lector: LectorDeResultados;

  constructor(lector: LectorDeResultados) {
    this.#lector = lector;
  }

  async construir(ahoraMs: number): Promise<BaseDeAnalisis> {
    const lecturas = await this.#lector.leerTodo();
    const { filas, videoDeFila } = ArmadorDeBase.unir(lecturas);
    MarcadorDeExclusiones.marcar(filas, videoDeFila, lecturas);
    return {
      version: VERSION_BASE, generado_en: new Date(ahoraMs).toISOString(),
      resumen: ArmadorDeBase.resumen(filas, lecturas.participantesRegistrados), filas,
    };
  }
}
