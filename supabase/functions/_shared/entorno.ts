// Lectura de variables de entorno de las Edge Functions. Ningún secreto vive en el repositorio:
// todos se leen de los Secrets de Supabase. Si falta uno, la función falla cerrada.

export type LectorEntorno = (nombre: string) => string | undefined;

/** Error controlado: su mensaje es una etiqueta fija, sin datos de la petición ni secretos. */
export class ErrorControlado extends Error {}

/** La base rechazó una inserción por un valor único repetido (HTTP 409 de PostgREST). */
export class ErrorConflicto extends ErrorControlado {}

export class Entorno {
  #leer: LectorEntorno;

  constructor(leer: LectorEntorno) {
    this.#leer = leer;
  }

  /** Valor obligatorio; si falta, la función se niega a operar. */
  requerido(nombre: string): string {
    const valor = this.#leer(nombre)?.trim();
    if (!valor) throw new ErrorControlado(`falta_variable_${nombre}`);
    return valor;
  }

  opcional(nombre: string): string | undefined {
    const valor = this.#leer(nombre)?.trim();
    return valor ? valor : undefined;
  }

  /** URL del proyecto que Supabase inyecta en las Edge Functions (SUPABASE_URL). */
  urlProyecto(): string {
    const url = this.requerido("SUPABASE_URL").replace(/\/+$/, "");
    if (!url.startsWith("https://")) throw new ErrorControlado("url_proyecto_invalida");
    return url;
  }

  /**
   * Clave secreta del proyecto. CORTO_SECRET_KEY si la configuraste (sb_secret_…);
   * si no, SUPABASE_SERVICE_ROLE_KEY, que Supabase inyecta por defecto.
   */
  claveServicio(): string {
    return this.opcional("CORTO_SECRET_KEY") ?? this.requerido("SUPABASE_SERVICE_ROLE_KEY");
  }

  /** Secreto para HMAC: exige un largo mínimo para no operar con uno débil. */
  secreto(nombre: string, minimo = 32): string {
    const valor = this.requerido(nombre);
    if (valor.length < minimo) throw new ErrorControlado(`secreto_corto_${nombre}`);
    return valor;
  }
}
