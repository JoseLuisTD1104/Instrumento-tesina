// Arranque común: en Supabase (Deno) registra el servidor; en las pruebas locales con Node no existe Deno.
import type { LectorEntorno } from "./entorno.ts";

export type Manejador = (peticion: Request, leer: LectorEntorno) => Promise<Response>;

export function servir(manejar: Manejador): void {
  // deno-lint-ignore no-explicit-any
  const D = (globalThis as any).Deno;
  if (D?.serve) D.serve((peticion: Request) => manejar(peticion, (n: string) => D.env.get(n)));
}
