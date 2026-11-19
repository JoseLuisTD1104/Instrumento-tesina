// Edge Function "video-firmado" de corto.
// Recibe { id } de un video, comprueba que está publicado y devuelve una URL firmada
// de pocos minutos para el bucket privado "videos".
//
// La clave secreta NUNCA está en el repositorio: se lee de las variables de entorno
// de Supabase (CORTO_SECRET_KEY si la configuras; si no, SUPABASE_SERVICE_ROLE_KEY,
// que Supabase define por defecto en las Edge Functions).

const ORIGEN_PERMITIDO = "https://joseluistd1104.github.io";
const SEGUNDOS_VALIDEZ = 180; // 3 minutos
const PATRON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATRON_RUTA = /^[0-9a-f-]{36}\.(mp4|webm|mov)$/i;

const CABECERAS_BASE = {
  "Access-Control-Allow-Origin": ORIGEN_PERMITIDO,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "600",
  "Vary": "Origin",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function responder(estado: number, cuerpo: Record<string, unknown> | null): Response {
  return new Response(cuerpo ? JSON.stringify(cuerpo) : null, {
    status: estado,
    headers: { ...CABECERAS_BASE, ...(cuerpo ? { "Content-Type": "application/json" } : {}) },
  });
}

function cabecerasServicio(clave: string): Record<string, string> {
  // Las claves nuevas (sb_secret_...) no son JWT: van solo en "apikey".
  // La service_role clásica sí es JWT y también va en Authorization.
  const h: Record<string, string> = { apikey: clave, "Content-Type": "application/json" };
  if (clave.startsWith("eyJ")) h.Authorization = `Bearer ${clave}`;
  return h;
}

export async function manejar(peticion: Request, entorno: (n: string) => string | undefined): Promise<Response> {
  // Solo el sitio del instrumento. Ojo: esto lo hacen cumplir los navegadores;
  // un programa fuera del navegador puede falsificar la cabecera Origin.
  if (peticion.headers.get("Origin") !== ORIGEN_PERMITIDO) return responder(403, { error: "origen_no_permitido" });
  if (peticion.method === "OPTIONS") return responder(204, null);
  if (peticion.method !== "POST") return responder(405, { error: "metodo_no_permitido" });

  const urlProyecto = (entorno("SUPABASE_URL") ?? "").replace(/\/+$/, "");
  const clave = entorno("CORTO_SECRET_KEY") ?? entorno("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!urlProyecto.startsWith("https://") || !clave) return responder(500, { error: "configuracion" });

  let id: unknown;
  try {
    const texto = await peticion.text();
    if (texto.length > 200) return responder(400, { error: "solicitud_invalida" });
    id = JSON.parse(texto)?.id;
  } catch {
    return responder(400, { error: "solicitud_invalida" });
  }
  if (typeof id !== "string" || !PATRON_ID.test(id)) return responder(400, { error: "solicitud_invalida" });

  try {
    // 1) El video debe existir y estar publicado.
    const consulta = new URL(`${urlProyecto}/rest/v1/videos`);
    consulta.searchParams.set("select", "ruta_archivo");
    consulta.searchParams.set("id", `eq.${id}`);
    consulta.searchParams.set("publicado", "eq.true");
    consulta.searchParams.set("limit", "1");
    const r1 = await fetch(consulta, { headers: cabecerasServicio(clave) });
    if (!r1.ok) return responder(502, { error: "servicio" });
    const filas = await r1.json();
    const ruta = Array.isArray(filas) ? filas[0]?.ruta_archivo : undefined;
    if (typeof ruta !== "string" || !PATRON_RUTA.test(ruta)) return responder(404, { error: "no_disponible" });

    // 2) URL firmada de pocos minutos.
    const r2 = await fetch(`${urlProyecto}/storage/v1/object/sign/videos/${encodeURIComponent(ruta)}`, {
      method: "POST",
      headers: cabecerasServicio(clave),
      body: JSON.stringify({ expiresIn: SEGUNDOS_VALIDEZ }),
    });
    if (!r2.ok) return responder(502, { error: "servicio" });
    const firmado = (await r2.json())?.signedURL;
    if (typeof firmado !== "string" || !firmado.startsWith("/")) return responder(502, { error: "servicio" });

    return responder(200, { url: `${urlProyecto}/storage/v1${firmado}`, expira_en: SEGUNDOS_VALIDEZ });
  } catch {
    return responder(502, { error: "servicio" });
  }
}

// En Supabase (Deno) se registra el servidor; en las pruebas locales con Node no existe Deno.
// deno-lint-ignore no-explicit-any
const D = (globalThis as any).Deno;
if (D?.serve) D.serve((peticion: Request) => manejar(peticion, (n) => D.env.get(n)));
