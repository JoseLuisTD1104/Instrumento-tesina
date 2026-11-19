// Respuestas HTTP, CORS y lectura segura de peticiones, comunes a todas las funciones de corto.
import { ErrorControlado } from "./entorno.ts";

export class CanalHttp {
  #origen: string;
  #metodos: string[];

  constructor(origenPermitido: string, metodos: string[]) {
    if (!/^https:\/\/[^/\s*]+$/.test(origenPermitido)) throw new ErrorControlado("origen_permitido_invalido");
    this.#origen = origenPermitido;
    this.#metodos = metodos;
  }

  #cabeceras(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "Access-Control-Allow-Origin": this.#origen, // nunca "*"
      "Access-Control-Allow-Methods": [...this.#metodos, "OPTIONS"].join(", "),
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Max-Age": "600",
      "Vary": "Origin",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extra,
    };
  }

  json(estado: number, cuerpo: unknown): Response {
    return new Response(JSON.stringify(cuerpo), {
      status: estado,
      headers: this.#cabeceras({ "Content-Type": "application/json; charset=utf-8" }),
    });
  }

  vacio(estado: number): Response {
    return new Response(null, { status: estado, headers: this.#cabeceras() });
  }

  /**
   * Filtro inicial: origen exacto, OPTIONS y métodos permitidos.
   * Devuelve una respuesta si hay que cortar; null si la petición puede seguir.
   * Ojo: el Origin lo hacen cumplir los navegadores; un programa externo puede falsificarlo.
   */
  filtrar(peticion: Request): Response | null {
    if (peticion.headers.get("Origin") !== this.#origen) return this.json(403, { error: "origen_no_permitido" });
    if (peticion.method === "OPTIONS") return this.vacio(204);
    if (!this.#metodos.includes(peticion.method)) return this.json(405, { error: "metodo_no_permitido" });
    return null;
  }

  /** Token de "Authorization: Bearer …" con un formato razonable, o null. */
  static bearer(peticion: Request): string | null {
    const valor = peticion.headers.get("Authorization") ?? "";
    const m = /^Bearer ([A-Za-z0-9_\-.]{20,4096})$/.exec(valor);
    return m ? m[1] : null;
  }

  /** Lee el cuerpo como JSON sin aceptar más de `maximo` bytes (ni declarados ni reales). */
  static async leerJson(peticion: Request, maximo: number): Promise<unknown> {
    const declarado = Number(peticion.headers.get("Content-Length") ?? "0");
    if (!Number.isFinite(declarado) || declarado > maximo) throw new ErrorControlado("cuerpo_grande");
    if (!peticion.body) return null;
    const lector = peticion.body.getReader();
    const partes: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximo) {
        await lector.cancel().catch(() => {});
        throw new ErrorControlado("cuerpo_grande");
      }
      partes.push(value);
    }
    if (total === 0) return null;
    const bytes = new Uint8Array(total);
    let pos = 0;
    for (const p of partes) { bytes.set(p, pos); pos += p.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  /** Registro de errores sin datos sensibles: nunca códigos, pases, IPs ni mensajes externos. */
  static registrarError(funcion: string, error: unknown): void {
    const etiqueta = error instanceof ErrorControlado ? error.message : (error instanceof Error ? error.name : "error");
    console.error(`[${funcion}] ${etiqueta}`);
  }

  /** Espera hasta el instante indicado (para respuestas con tiempo mínimo fijo). */
  static async esperarHasta(instanteMs: number): Promise<void> {
    const falta = instanteMs - Date.now();
    if (falta > 0) await new Promise((r) => setTimeout(r, falta));
  }
}
