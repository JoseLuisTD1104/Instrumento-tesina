// Material de reconocimiento: actores (public.actores), sus caras y las miniaturas de los videos, guardadas
// en el bucket privado "reconocimiento". Solo la clave de servicio escribe y firma. Las rutas siempre las
// genera el servidor (caras/<uuid>.<ext> o miniaturas/<uuid>.<ext>); nunca se aceptan del cliente.
// Ningún id, alias ni ruta va a los logs.
import { ErrorControlado } from "./entorno.ts";
import { PATRON_UUID } from "./progreso.ts";
import { ClienteRest } from "./supabase.ts";

export const BUCKET_RECONOCIMIENTO = "reconocimiento";
export const SEGUNDOS_FIRMA = 600; // 10 minutos

export type Carpeta = "caras" | "miniaturas";
export type Imagen = { bytes: Uint8Array; ext: "jpg" | "png" | "webp"; tipo: string };
export type Actor = { id: string; alias: string; cara_ruta: string };
export type VideoDeReconocimiento = { id: string; actor_id: string | null; miniatura_ruta: string | null };

const PATRON_RUTA: Record<Carpeta, RegExp> = {
  caras: /^caras\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/,
  miniaturas: /^miniaturas\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/,
};

/** Ruta del bucket con el formato que genera el servidor, o null. */
export function rutaValida(carpeta: Carpeta, ruta: unknown): string | null {
  return typeof ruta === "string" && PATRON_RUTA[carpeta].test(ruta) ? ruta : null;
}

/** Imagen en base64: el tipo se decide por los bytes iniciales, nunca por la extensión ni lo declarado. */
export class ValidadorDeImagen {
  static MAX_BYTES = 400 * 1024;
  static MAX_BASE64 = Math.ceil(ValidadorDeImagen.MAX_BYTES / 3) * 4;
  static PATRON_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

  static validar(texto: unknown): Imagen | null {
    if (typeof texto !== "string" || texto.length < 16 || texto.length > ValidadorDeImagen.MAX_BASE64) return null;
    if (texto.length % 4 !== 0 || !ValidadorDeImagen.PATRON_BASE64.test(texto)) return null;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(texto), (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
    if (bytes.length > ValidadorDeImagen.MAX_BYTES) return null;
    const b = bytes;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { bytes, ext: "jpg", tipo: "image/jpeg" };
    if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return { bytes, ext: "png", tipo: "image/png" };
    const riff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
    const webp = b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    if (riff && webp) return { bytes, ext: "webp", tipo: "image/webp" };
    return null;
  }
}

/** Alias de un actor: 1 a 30 caracteres, sin < > " & ni caracteres de control (igual que la base). */
export class ValidadorDeAlias {
  static MAX = 30;
  static PROHIBIDOS = /[<>"&]/;
  static CONTROL = /\p{Cc}/u;

  static normalizar(valor: unknown): string | null {
    if (typeof valor !== "string") return null;
    const alias = valor.normalize("NFC").replace(/\s+/g, " ").trim();
    const largo = [...alias].length;
    if (largo < 1 || largo > ValidadorDeAlias.MAX) return null;
    if (ValidadorDeAlias.PROHIBIDOS.test(alias) || ValidadorDeAlias.CONTROL.test(alias)) return null;
    return alias;
  }
}

/** Objetos del bucket "reconocimiento". */
export class AlmacenDeReconocimiento {
  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  /** Sube la imagen con una ruta nueva generada aquí y la devuelve. */
  async subir(carpeta: Carpeta, imagen: Imagen): Promise<string> {
    const ruta = `${carpeta}/${crypto.randomUUID()}.${imagen.ext}`;
    await this.#servicio.subirObjeto(BUCKET_RECONOCIMIENTO, ruta, imagen.bytes, imagen.tipo);
    return ruta;
  }

  /** Borra objetos; solo rutas con el formato del servidor. Si falla, lanza. */
  async borrar(carpeta: Carpeta, rutas: (string | null)[]): Promise<void> {
    const validas = rutas.map((r) => rutaValida(carpeta, r)).filter((r): r is string => r !== null);
    await this.#servicio.borrarObjetos(BUCKET_RECONOCIMIENTO, validas);
  }

  /** URLs firmadas de 10 minutos, Map(ruta → url). Lanza si alguna ruta no es válida o no se firmó. */
  async firmar(carpeta: Carpeta, rutas: string[]): Promise<Map<string, string>> {
    if (!rutas.every((r) => rutaValida(carpeta, r))) throw new ErrorControlado("ruta_reconocimiento_ilegible");
    return await this.#servicio.firmarVarias(BUCKET_RECONOCIMIENTO, rutas, SEGUNDOS_FIRMA);
  }
}

/** Tabla public.actores (solo clave de servicio). */
export class RegistroDeActores {
  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  static #interpretar(f: Record<string, unknown>): Actor {
    const id = typeof f.id === "string" && PATRON_UUID.test(f.id) ? f.id.toLowerCase() : null;
    const cara = rutaValida("caras", f.cara_ruta);
    if (!id || typeof f.alias !== "string" || !cara) throw new ErrorControlado("actor_ilegible");
    return { id, alias: f.alias, cara_ruta: cara };
  }

  async listar(): Promise<Actor[]> {
    const filas = await this.#servicio.consultar("actores", { select: "id,alias,cara_ruta", order: "alias.asc,id.asc" });
    return filas.map(RegistroDeActores.#interpretar);
  }

  async leer(id: string): Promise<Actor | null> {
    const filas = await this.#servicio.consultar("actores", { select: "id,alias,cara_ruta", id: `eq.${id}`, limit: "1" });
    return filas.length === 1 ? RegistroDeActores.#interpretar(filas[0]) : null;
  }

  /** Los actores de `ids` en ese mismo orden. Lanza si falta alguno (falla cerrada). */
  async enOrden(ids: string[]): Promise<Actor[]> {
    if (!ids.length) return [];
    if (!ids.every((id) => PATRON_UUID.test(id))) throw new ErrorControlado("actor_id_ilegible");
    const filas = await this.#servicio.consultar("actores", { select: "id,alias,cara_ruta", id: `in.(${ids.join(",")})` });
    const porId = new Map(filas.map(RegistroDeActores.#interpretar).map((a) => [a.id, a]));
    return ids.map((id) => {
      const a = porId.get(id);
      if (!a) throw new ErrorControlado("actor_ausente");
      return a;
    });
  }

  /** Lanza ErrorConflicto si el alias ya existe. */
  async crear(alias: string, caraRuta: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.#servicio.insertar("actores", { id, alias, cara_ruta: caraRuta });
    return id;
  }

  /** Cambia la cara solo si sigue siendo la `anterior` (dos cambios a la vez no se pisan). */
  async cambiarCara(id: string, anterior: string, nueva: string): Promise<boolean> {
    const filas = await this.#servicio.actualizar("actores",
      { id: `eq.${id}`, cara_ruta: `eq.${anterior}`, select: "id" }, { cara_ruta: nueva });
    return filas.length === 1;
  }

  /** La llave foránea (restrict) impide borrar un actor con videos: en ese caso lanza ErrorConflicto. */
  async borrar(id: string): Promise<void> {
    await this.#servicio.borrar("actores", { id: `eq.${id}` });
  }
}

/** Columnas de reconocimiento de public.videos. */
export class VideosDeReconocimiento {
  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  static #interpretar(f: Record<string, unknown>): VideoDeReconocimiento {
    const id = typeof f.id === "string" && PATRON_UUID.test(f.id) ? f.id.toLowerCase() : null;
    if (!id) throw new ErrorControlado("video_ilegible");
    const actor = typeof f.actor_id === "string" && PATRON_UUID.test(f.actor_id) ? f.actor_id.toLowerCase() : null;
    if (f.actor_id != null && !actor) throw new ErrorControlado("video_actor_ilegible");
    const miniatura = rutaValida("miniaturas", f.miniatura_ruta);
    if (f.miniatura_ruta != null && !miniatura) throw new ErrorControlado("video_miniatura_ilegible");
    return { id, actor_id: actor, miniatura_ruta: miniatura };
  }

  async leer(id: string): Promise<VideoDeReconocimiento | null> {
    const filas = await this.#servicio.consultar("videos", { select: "id,actor_id,miniatura_ruta", id: `eq.${id}`, limit: "1" });
    return filas.length === 1 ? VideosDeReconocimiento.#interpretar(filas[0]) : null;
  }

  async todos(): Promise<VideoDeReconocimiento[]> {
    const filas = await this.#servicio.consultar("videos", { select: "id,actor_id,miniatura_ruta", order: "id.asc" });
    return filas.map(VideosDeReconocimiento.#interpretar);
  }

  /** Los videos de `ids` en ese mismo orden. Lanza si falta alguno (falla cerrada). */
  async enOrden(ids: string[]): Promise<VideoDeReconocimiento[]> {
    if (!ids.length || !ids.every((id) => PATRON_UUID.test(id))) throw new ErrorControlado("orden_ilegible");
    const filas = await this.#servicio.consultar("videos", { select: "id,actor_id,miniatura_ruta", id: `in.(${ids.join(",")})` });
    const porId = new Map(filas.map((f) => VideosDeReconocimiento.#interpretar(f)).map((v) => [v.id, v]));
    return ids.map((id) => {
      const v = porId.get(id);
      if (!v) throw new ErrorControlado("video_del_orden_ausente");
      return v;
    });
  }

  /** Cambia la miniatura solo si sigue siendo la `anterior`. */
  async cambiarMiniatura(id: string, anterior: string | null, nueva: string): Promise<boolean> {
    const filas = await this.#servicio.actualizar("videos",
      { id: `eq.${id}`, miniatura_ruta: anterior === null ? "is.null" : `eq.${anterior}`, select: "id" }, { miniatura_ruta: nueva });
    return filas.length === 1;
  }

  async asignarActor(id: string, actorId: string | null): Promise<boolean> {
    const filas = await this.#servicio.actualizar("videos", { id: `eq.${id}`, select: "id" }, { actor_id: actorId });
    return filas.length === 1;
  }

  async cuantosDelActor(actorId: string): Promise<number> {
    return await this.#servicio.contar("videos", { actor_id: `eq.${actorId}` });
  }
}

/** Orden pseudoaleatorio estable por participante: por SHA-256(código + ":" + id). No cambia al recargar. */
export class OrdenEstable {
  static async ordenar(codigo: string, ids: string[]): Promise<string[]> {
    const conClave = await Promise.all(ids.map(async (id) => {
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${codigo}:${id}`)));
      return { id, clave: Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("") };
    }));
    return conClave.sort((a, b) => (a.clave < b.clave ? -1 : a.clave > b.clave ? 1 : 0)).map((x) => x.id);
  }
}

/** Actores distintos entre los videos (en el orden en que aparecen). Los videos sin actor se ignoran. */
export function actoresDe(videos: VideoDeReconocimiento[]): string[] {
  return [...new Set(videos.map((v) => v.actor_id).filter((id): id is string => id !== null))];
}
