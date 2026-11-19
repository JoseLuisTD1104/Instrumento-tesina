// Edge Function "video-firmado" de corto (pública con pase).
// Con un pase de participante válido recibe { id } de un video, comprueba que está publicado y
// devuelve una URL firmada de pocos minutos para el bucket privado "videos". Sin pase: 401 y no firma.
//
// La clave secreta NUNCA está en el repositorio: se lee de las variables de entorno de Supabase
// (CORTO_SECRET_KEY si la configuraste; si no, SUPABASE_SERVICE_ROLE_KEY, que Supabase inyecta).
import { Entorno, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { PaseParticipante } from "../_shared/pase.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "video-firmado";
const SEGUNDOS_VALIDEZ = 180; // 3 minutos
const PATRON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATRON_RUTA = /^[0-9a-f-]{36}\.(mp4|webm|mov)$/i;

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
    // Primero el pase: sin él no se lee ni se firma nada.
    const pase = new PaseParticipante(entorno.secreto("TOKEN_SECRETO"));
    if (!(await pase.verificar(CanalHttp.bearer(peticion)))) return canal.json(401, { error: "pase_invalido" });

    let id: unknown;
    try {
      id = (await CanalHttp.leerJson(peticion, 200) as { id?: unknown } | null)?.id;
    } catch {
      return canal.json(400, { error: "solicitud_invalida" });
    }
    if (typeof id !== "string" || !PATRON_ID.test(id)) return canal.json(400, { error: "solicitud_invalida" });

    // 1) El video debe existir y estar publicado.
    const servicio = ClienteRest.deServicio(entorno);
    const filas = await servicio.consultar("videos", { select: "ruta_archivo", id: `eq.${id}`, publicado: "eq.true", limit: "1" });
    const ruta = filas[0]?.ruta_archivo;
    if (typeof ruta !== "string" || !PATRON_RUTA.test(ruta)) return canal.json(404, { error: "no_disponible" });

    // 2) URL firmada de pocos minutos.
    const url = await servicio.firmar("videos", ruta, SEGUNDOS_VALIDEZ);
    return canal.json(200, { url, expira_en: SEGUNDOS_VALIDEZ });
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(502, { error: "servicio" });
  }
}

servir(manejar);
