// Acceso a la API REST de Supabase (PostgREST, Auth y Storage) con fetch.
// Cada respuesta no exitosa se convierte en un ErrorControlado sin detalles.
import { Entorno, ErrorConflicto, ErrorControlado } from "./entorno.ts";

type Fila = Record<string, unknown>;

export class ClienteRest {
  #url: string;
  #cabeceras: Record<string, string>;

  /**
   * apikey: clave del proyecto (secreta o publicable). jwt: token del usuario, si la operación debe
   * hacerse con sus permisos para que apliquen las reglas RLS.
   */
  constructor(urlProyecto: string, apikey: string, jwt?: string) {
    this.#url = urlProyecto;
    this.#cabeceras = { apikey, "Content-Type": "application/json" };
    // Las claves nuevas (sb_…) no son JWT: solo van en "apikey". Las clásicas (eyJ…) también en Authorization.
    const bearer = jwt ?? (apikey.startsWith("eyJ") ? apikey : undefined);
    if (bearer) this.#cabeceras.Authorization = `Bearer ${bearer}`;
  }

  /** Cliente con la clave secreta: ignora RLS. Solo para operaciones que la función ya validó. */
  static deServicio(entorno: Entorno): ClienteRest {
    return new ClienteRest(entorno.urlProyecto(), entorno.claveServicio());
  }

  async consultar(tabla: string, parametros: Record<string, string>): Promise<Fila[]> {
    const r = await fetch(this.#rest(tabla, parametros), { headers: this.#cabeceras });
    if (!r.ok) throw new ErrorControlado(`consulta_${tabla}_${r.status}`);
    const datos = await r.json();
    if (!Array.isArray(datos)) throw new ErrorControlado(`respuesta_${tabla}`);
    return datos;
  }

  /** Cuenta filas con Prefer: count=exact sin descargarlas. */
  async contar(tabla: string, parametros: Record<string, string>): Promise<number> {
    const r = await fetch(this.#rest(tabla, { ...parametros, select: "id", limit: "1" }), {
      headers: { ...this.#cabeceras, Prefer: "count=exact" },
    });
    if (!r.ok) throw new ErrorControlado(`conteo_${tabla}_${r.status}`);
    await r.body?.cancel();
    const total = Number((r.headers.get("Content-Range") ?? "").split("/")[1]);
    if (!Number.isInteger(total) || total < 0) throw new ErrorControlado(`conteo_${tabla}`);
    return total;
  }

  /** Consulta con el total de filas que cumplen los filtros (Prefer: count=exact), para paginar. */
  async consultarConTotal(tabla: string, parametros: Record<string, string>): Promise<{ filas: Fila[]; total: number }> {
    const r = await fetch(this.#rest(tabla, parametros), { headers: { ...this.#cabeceras, Prefer: "count=exact" } });
    if (!r.ok) throw new ErrorControlado(`consulta_${tabla}_${r.status}`);
    const filas = await r.json();
    const total = Number((r.headers.get("Content-Range") ?? "").split("/")[1]);
    if (!Array.isArray(filas) || !Number.isInteger(total) || total < 0) throw new ErrorControlado(`respuesta_${tabla}`);
    return { filas, total };
  }

  /** Inserta una fila o varias en una sola sentencia (todas o ninguna). */
  async insertar(tabla: string, fila: Fila | Fila[]): Promise<void> {
    const r = await fetch(this.#rest(tabla, {}), {
      method: "POST", headers: { ...this.#cabeceras, Prefer: "return=minimal" }, body: JSON.stringify(fila),
    });
    if (r.status === 409) throw new ErrorConflicto(`conflicto_${tabla}`);
    if (!r.ok) throw new ErrorControlado(`insercion_${tabla}_${r.status}`);
  }

  /** Inserta o, si ya existe una fila con el mismo valor en `conflicto`, la actualiza (upsert de PostgREST). */
  async insertarOActualizar(tabla: string, fila: Fila, conflicto: string): Promise<void> {
    const r = await fetch(this.#rest(tabla, { on_conflict: conflicto }), {
      method: "POST", headers: { ...this.#cabeceras, Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(fila),
    });
    if (!r.ok) throw new ErrorControlado(`upsert_${tabla}_${r.status}`);
  }

  async actualizar(tabla: string, filtros: Record<string, string>, cambios: Fila): Promise<Fila[]> {
    const r = await fetch(this.#rest(tabla, filtros), {
      method: "PATCH", headers: { ...this.#cabeceras, Prefer: "return=representation" }, body: JSON.stringify(cambios),
    });
    if (r.status === 409) throw new ErrorConflicto(`conflicto_actualizacion_${tabla}`); // p. ej., índice único
    if (!r.ok) throw new ErrorControlado(`actualizacion_${tabla}_${r.status}`);
    const datos = await r.json();
    if (!Array.isArray(datos)) throw new ErrorControlado(`respuesta_${tabla}`);
    return datos;
  }

  async borrar(tabla: string, filtros: Record<string, string>): Promise<void> {
    const r = await fetch(this.#rest(tabla, filtros), {
      method: "DELETE", headers: { ...this.#cabeceras, Prefer: "return=minimal" },
    });
    if (r.status === 409) throw new ErrorConflicto(`conflicto_borrado_${tabla}`);
    if (!r.ok) throw new ErrorControlado(`borrado_${tabla}_${r.status}`);
  }

  /** Usuario dueño del JWT, verificado por Supabase Auth (auth.getUser). null si no es válido. */
  async usuarioActual(): Promise<{ id: string } | null> {
    const r = await fetch(`${this.#url}/auth/v1/user`, { headers: this.#cabeceras });
    if (r.status === 401 || r.status === 403) return null;
    if (!r.ok) throw new ErrorControlado(`usuario_${r.status}`);
    const datos = await r.json();
    return typeof datos?.id === "string" ? { id: datos.id } : null;
  }

  /** URL firmada de Storage. Devuelve la URL completa. */
  async firmar(bucket: string, ruta: string, segundos: number): Promise<string> {
    const r = await fetch(`${this.#url}/storage/v1/object/sign/${bucket}/${encodeURIComponent(ruta)}`, {
      method: "POST", headers: this.#cabeceras, body: JSON.stringify({ expiresIn: segundos }),
    });
    if (!r.ok) throw new ErrorControlado(`firma_${r.status}`);
    const firmado = (await r.json())?.signedURL;
    if (typeof firmado !== "string" || !firmado.startsWith("/")) throw new ErrorControlado("firma_respuesta");
    return `${this.#url}/storage/v1${firmado}`;
  }

  /** Varias URLs firmadas en una sola petición. Devuelve Map(ruta → URL completa); lanza si falta alguna. */
  async firmarVarias(bucket: string, rutas: string[], segundos: number): Promise<Map<string, string>> {
    const unicas = [...new Set(rutas)];
    if (!unicas.length) return new Map();
    const r = await fetch(`${this.#url}/storage/v1/object/sign/${bucket}`, {
      method: "POST", headers: this.#cabeceras, body: JSON.stringify({ expiresIn: segundos, paths: unicas }),
    });
    if (!r.ok) throw new ErrorControlado(`firmas_${r.status}`);
    const datos = await r.json();
    if (!Array.isArray(datos)) throw new ErrorControlado("firmas_respuesta");
    const urls = new Map<string, string>();
    for (const d of datos) {
      if (typeof d?.path === "string" && typeof d?.signedURL === "string" && d.signedURL.startsWith("/") && !d.error) {
        urls.set(d.path, `${this.#url}/storage/v1${d.signedURL}`);
      }
    }
    if (!unicas.every((ruta) => urls.has(ruta))) throw new ErrorControlado("firmas_incompletas");
    return urls;
  }

  /** Sube un objeto nuevo a Storage (sin sobrescribir). */
  async subirObjeto(bucket: string, ruta: string, bytes: Uint8Array, tipo: string): Promise<void> {
    const r = await fetch(`${this.#url}/storage/v1/object/${bucket}/${ruta.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST", headers: { ...this.#cabeceras, "Content-Type": tipo, "x-upsert": "false" }, body: bytes,
    });
    if (!r.ok) throw new ErrorControlado(`subida_${r.status}`);
    await r.body?.cancel();
  }

  /** Borra objetos de Storage. Borrar uno que no existe no es error. */
  async borrarObjetos(bucket: string, rutas: string[]): Promise<void> {
    if (!rutas.length) return;
    const r = await fetch(`${this.#url}/storage/v1/object/${bucket}`, {
      method: "DELETE", headers: this.#cabeceras, body: JSON.stringify({ prefixes: rutas }),
    });
    if (!r.ok) throw new ErrorControlado(`borrado_objetos_${r.status}`);
    await r.body?.cancel();
  }

  #rest(tabla: string, parametros: Record<string, string>): URL {
    const url = new URL(`${this.#url}/rest/v1/${tabla}`);
    for (const [k, v] of Object.entries(parametros)) url.searchParams.set(k, v);
    return url;
  }
}
