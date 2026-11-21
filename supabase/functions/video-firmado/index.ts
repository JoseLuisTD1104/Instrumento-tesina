// Edge Function "video-firmado" de corto (pública con pase).
// Con un pase de participante válido (y emitido después del último cierre de sesiones) recibe { id }
// de un video. Solo firma el video actual o el siguiente de la fase a ciegas del participante (y si está
// publicado): cualquier otro recibe el rechazo genérico. Devuelve una URL firmada de pocos minutos para el
// bucket privado "videos". Sin pase válido: 401 y no firma. No revisa abierto_hasta.
//
// La clave secreta NUNCA está en el repositorio: se lee de las variables de entorno de Supabase
// (CORTO_SECRET_KEY si la configuraste; si no, SUPABASE_SERVICE_ROLE_KEY, que Supabase inyecta).
import { Entorno, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { ParticipanteActual } from "../_shared/participante-actual.ts";
import { FaseCiega, PATRON_UUID } from "../_shared/progreso.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "video-firmado";
const SEGUNDOS_VALIDEZ = 180; // 3 minutos
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
    const servicio = ClienteRest.deServicio(entorno);
    // 401 si el pase no vale (vencido, revocado, sin fila); 403 si aún no aceptó el aviso ni dio sus datos.
    const participante = await new ParticipanteActual(entorno, servicio).abrir(CanalHttp.bearer(peticion));
    if ("rechazo" in participante) return canal.json(participante.rechazo.estado, { error: participante.rechazo.error });

    let id: unknown;
    try {
      id = (await CanalHttp.leerJson(peticion, 200) as { id?: unknown } | null)?.id;
    } catch {
      return canal.rechazo();
    }
    if (typeof id !== "string" || !PATRON_UUID.test(id)) return canal.rechazo();
    id = id.toLowerCase();

    // 1) Solo el video actual o el siguiente de la fase a ciegas; debe existir y estar publicado.
    if (!FaseCiega.visibles(participante.progreso).includes(id as string)) return canal.rechazo();
    const filas = await servicio.consultar("videos", { select: "ruta_archivo", id: `eq.${id}`, publicado: "eq.true", limit: "1" });
    const ruta = filas[0]?.ruta_archivo;
    if (typeof ruta !== "string" || !PATRON_RUTA.test(ruta)) return canal.rechazo();

    // 2) URL firmada de pocos minutos.
    const url = await servicio.firmar("videos", ruta, SEGUNDOS_VALIDEZ);
    return canal.json(200, { url, expira_en: SEGUNDOS_VALIDEZ });
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(502, { error: "servicio" });
  }
}

servir(manejar);
