// Edge Function "admin-datos" (solo administrador). Lectura de los datos de interacción del feed para la
// pestaña "Datos" del panel. Verifica la sesión igual que admin-reconocimiento (JWT verificado por Supabase
// Auth y comparado con ADMIN_UID; falla cerrada) y lee con la clave de servicio, que nunca sale de aquí: las
// tablas siguen cerradas para anon y authenticated. Solo POST con JSON de máx. 4 KB y { accion, ... }:
// - opciones: { participantes: [codigo], videos: [numero_video] } para los filtros.
// - pagina { vista, filtros, orden, pagina, tamano }: { filas, total }.
// - exportar { vista, filtros, orden }: { filas, total } con todas las filas (se leen de 1000 en 1000).
// vista: "clics" (public.interacciones) o "visualizacion" (public.visualizaciones). filtros: { participante?,
// video? (numero_video), tipo? (clics) o fase? (visualizacion) }. orden: { columna, direccion: "asc"|"desc" }.
// Cada fila lleva numero_video en lugar de video_id (null si el video ya no existe). Nunca se leen ni devuelven
// nombre ni matrícula. Errores con etiquetas fijas; nunca registra códigos, ids ni tokens.
import { Entorno, ErrorControlado, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { VerificadorDeAdministrador } from "../_shared/administrador.ts";
import { ValidadorDeInteraccion } from "../_shared/interacciones.ts";
import { GeneradorCodigoParticipante } from "../_shared/participantes.ts";
import { PATRON_UUID } from "../_shared/progreso.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "admin-datos";
const MAX_CUERPO_BYTES = 4096;

type Fila = Record<string, unknown>;
type Vista = {
  tabla: string;
  /** Columnas que se leen de la tabla, en el orden de salida (video_id se cambia por numero_video). */
  columnas: string[];
  /** Filtro propio de la vista y sus valores permitidos. */
  filtro: { nombre: string; valores: ReadonlySet<string> };
  /** Orden estable para leer por lotes: las filas nuevas quedan al final y el orden no tiene empates. */
  estable: string[];
};

const VISTAS: Record<string, Vista> = {
  clics: {
    tabla: "interacciones",
    columnas: ["codigo_participante", "video_id", "tipo", "detalle", "tiempo_video_ms", "duracion_ms", "creado_en"],
    filtro: { nombre: "tipo", valores: ValidadorDeInteraccion.TIPOS },
    estable: ["id"],
  },
  visualizacion: {
    tabla: "visualizaciones",
    columnas: ["codigo_participante", "video_id", "fase", "posicion", "tiempo_pantalla_ms", "reproduccion_ms", "completo", "creado_en"],
    filtro: { nombre: "fase", valores: new Set(["ciega", "evaluacion"]) },
    estable: ["creado_en", "codigo_participante", "video_id", "fase"],
  },
};

const COLUMNA_VIDEO = "numero_video";
const TAMANOS = new Set([25, 50, 100]);
const LOTE = 1000; // máximo de filas por consulta de PostgREST
const MAX_FILAS = 200_000; // tope de seguridad de memoria al exportar

/** Petición validada. */
type Consulta = {
  vista: Vista;
  participante: string | null;
  video: number | null;
  extra: string | null;
  orden: { columna: string; asc: boolean };
};

/** Reglas exactas del cuerpo. Cualquier campo de más, de menos o fuera de rango la invalida. */
class ValidadorDeConsulta {
  static #objeto(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  static #soloClaves(o: Record<string, unknown>, permitidas: string[], obligatorias: string[] = []): boolean {
    const claves = Object.keys(o);
    return claves.every((k) => permitidas.includes(k)) && obligatorias.every((k) => claves.includes(k));
  }

  static columnasDeOrden(vista: Vista): string[] {
    return vista.columnas.map((c) => (c === "video_id" ? COLUMNA_VIDEO : c));
  }

  static validar(c: Record<string, unknown>, conPagina: boolean): (Consulta & { pagina: number; tamano: number }) | null {
    const claves = conPagina ? ["accion", "vista", "filtros", "orden", "pagina", "tamano"] : ["accion", "vista", "filtros", "orden"];
    if (!ValidadorDeConsulta.#soloClaves(c, claves, claves)) return null;
    const vista = typeof c.vista === "string" && Object.hasOwn(VISTAS, c.vista) ? VISTAS[c.vista] : null;
    if (!vista) return null;

    const f = c.filtros;
    if (!ValidadorDeConsulta.#objeto(f) || !ValidadorDeConsulta.#soloClaves(f, ["participante", "video", vista.filtro.nombre])) return null;
    const participante = f.participante ?? null;
    if (participante !== null && (typeof participante !== "string" || !GeneradorCodigoParticipante.PATRON.test(participante))) return null;
    const video = f.video ?? null;
    if (video !== null && (typeof video !== "number" || !Number.isInteger(video) || video < 1 || video > 1_000_000)) return null;
    const extra = f[vista.filtro.nombre] ?? null;
    if (extra !== null && (typeof extra !== "string" || !vista.filtro.valores.has(extra))) return null;

    const o = c.orden;
    if (!ValidadorDeConsulta.#objeto(o) || !ValidadorDeConsulta.#soloClaves(o, ["columna", "direccion"], ["columna", "direccion"])) return null;
    if (typeof o.columna !== "string" || !ValidadorDeConsulta.columnasDeOrden(vista).includes(o.columna)) return null;
    if (o.direccion !== "asc" && o.direccion !== "desc") return null;

    let pagina = 1;
    let tamano = LOTE;
    if (conPagina) {
      if (typeof c.pagina !== "number" || !Number.isInteger(c.pagina) || c.pagina < 1 || c.pagina > 1_000_000) return null;
      if (typeof c.tamano !== "number" || !TAMANOS.has(c.tamano)) return null;
      pagina = c.pagina;
      tamano = c.tamano;
    }
    return {
      vista, participante: participante as string | null, video: video as number | null, extra: extra as string | null,
      orden: { columna: o.columna, asc: o.direccion === "asc" }, pagina, tamano,
    };
  }
}

/** Lecturas paginadas de las tablas de interacción, con numero_video en lugar de video_id. */
class LectorDeDatos {
  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  async opciones(): Promise<{ participantes: string[]; videos: number[] }> {
    const [progreso, videos] = await Promise.all([
      this.#servicio.consultar("progreso_participante", { select: "codigo_participante", order: "codigo_participante.asc" }),
      this.#numerosDeVideo(),
    ]);
    const participantes = progreso.map((f) => f.codigo_participante)
      .filter((c): c is string => typeof c === "string" && GeneradorCodigoParticipante.PATRON.test(c));
    return { participantes, videos: [...new Set(videos.values())].sort((a, b) => a - b) };
  }

  /** Una página. Si se ordena por numero_video (no es columna de la tabla), se ordena aquí sobre todas. */
  async pagina(c: Consulta, pagina: number, tamano: number): Promise<{ filas: Fila[]; total: number }> {
    if (c.orden.columna === COLUMNA_VIDEO) {
      const todas = await this.todas(c);
      return { filas: todas.filas.slice((pagina - 1) * tamano, pagina * tamano), total: todas.total };
    }
    const filtros = await this.#filtros(c);
    if (!filtros) return { filas: [], total: 0 };
    const [numeros, { filas, total }] = await Promise.all([
      this.#numerosDeVideo(),
      this.#servicio.consultarConTotal(c.vista.tabla, {
        ...filtros, select: c.vista.columnas.join(","), order: this.#orden(c), limit: String(tamano), offset: String((pagina - 1) * tamano),
      }),
    ]);
    return { filas: filas.map((f) => this.#salida(c.vista, f, numeros)), total };
  }

  /** Todas las filas que cumplen los filtros, en el orden pedido. Se leen por lotes de 1000. */
  async todas(c: Consulta): Promise<{ filas: Fila[]; total: number }> {
    const filtros = await this.#filtros(c);
    if (!filtros) return { filas: [], total: 0 };
    const numeros = await this.#numerosDeVideo();
    const filas: Fila[] = [];
    for (let desde = 0; ; desde += LOTE) {
      const lote = await this.#servicio.consultar(c.vista.tabla, {
        ...filtros, select: c.vista.columnas.join(","), order: c.vista.estable.map((k) => `${k}.asc`).join(","),
        limit: String(LOTE), offset: String(desde),
      });
      for (const f of lote) filas.push(this.#salida(c.vista, f, numeros));
      if (filas.length > MAX_FILAS) throw new ErrorControlado("demasiadas_filas");
      if (lote.length < LOTE) break;
    }
    // Orden estable: con valores iguales se conserva el orden de lectura.
    const { columna, asc } = c.orden;
    filas.sort((a, b) => LectorDeDatos.#comparar(a[columna], b[columna], asc));
    return { filas, total: filas.length };
  }

  /** null en orden ascendente va al final, como en PostgreSQL; en descendente, al principio. */
  static #comparar(a: unknown, b: unknown, asc: boolean): number {
    if (a === b) return 0;
    if (a === null || a === undefined) return asc ? 1 : -1;
    if (b === null || b === undefined) return asc ? -1 : 1;
    const r = typeof a === "number" && typeof b === "number" ? a - b : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
    return asc ? r : -r;
  }

  #orden(c: Consulta): string {
    const direccion = c.orden.asc ? "asc" : "desc";
    const desempate = c.vista.estable.filter((k) => k !== c.orden.columna).map((k) => `${k}.asc`);
    return [`${c.orden.columna}.${direccion}`, ...desempate].join(",");
  }

  /** Filtros de PostgREST; null si el filtro de video no corresponde a ningún video (no hay filas). */
  async #filtros(c: Consulta): Promise<Record<string, string> | null> {
    const filtros: Record<string, string> = {};
    if (c.participante) filtros.codigo_participante = `eq.${c.participante}`;
    if (c.extra) filtros[c.vista.filtro.nombre] = `eq.${c.extra}`;
    if (c.video !== null) {
      const ids = [...(await this.#numerosDeVideo())].filter(([, n]) => n === c.video).map(([id]) => id);
      if (!ids.length) return null;
      filtros.video_id = `in.(${ids.join(",")})`;
    }
    return filtros;
  }

  /** Map(video_id → numero_video) de los videos que existen y tienen número. */
  async #numerosDeVideo(): Promise<Map<string, number>> {
    const filas = await this.#servicio.consultar("videos", { select: "id,numero_video", numero_video: "not.is.null" });
    const numeros = new Map<string, number>();
    for (const f of filas) {
      if (typeof f.id === "string" && PATRON_UUID.test(f.id) && Number.isInteger(f.numero_video)) numeros.set(f.id.toLowerCase(), f.numero_video as number);
    }
    return numeros;
  }

  /** Las columnas de la vista en su orden, con numero_video en lugar de video_id y los valores tal como están. */
  #salida(vista: Vista, f: Fila, numeros: Map<string, number>): Fila {
    return Object.fromEntries(vista.columnas.map((col) => (col === "video_id"
      ? [COLUMNA_VIDEO, typeof f.video_id === "string" ? numeros.get(f.video_id.toLowerCase()) ?? null : null]
      : [col, f[col] ?? null])));
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
    // 1) Solo el administrador: sin su sesión no se lee nada.
    if (!(await new VerificadorDeAdministrador(entorno).verificar(peticion))) return canal.json(401, { error: "no_autorizado" });

    // 2) Acción y campos exactos.
    let cuerpo: unknown;
    try {
      cuerpo = await CanalHttp.leerJson(peticion, MAX_CUERPO_BYTES);
    } catch {
      return canal.rechazo();
    }
    if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) return canal.rechazo();
    const c = cuerpo as Record<string, unknown>;

    // 3) La lectura, con la clave de servicio (ya se verificó al administrador).
    const lector = new LectorDeDatos(ClienteRest.deServicio(entorno));
    if (c.accion === "opciones") {
      return Object.keys(c).length === 1 ? canal.json(200, await lector.opciones()) : canal.rechazo();
    }
    if (c.accion !== "pagina" && c.accion !== "exportar") return canal.rechazo();
    const consulta = ValidadorDeConsulta.validar(c, c.accion === "pagina");
    if (!consulta) return canal.rechazo();
    const resultado = c.accion === "pagina"
      ? await lector.pagina(consulta, consulta.pagina, consulta.tamano)
      : await lector.todas(consulta);
    return canal.json(200, resultado);
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    if (e instanceof ErrorControlado && e.message === "demasiadas_filas") return canal.json(413, { error: "demasiadas_filas" });
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
