// Edge Function "feed-videos" (pública con pase). Con un pase de participante válido (y emitido
// después del último cierre de sesiones) devuelve solo los videos publicados, en cola por
// publicado_en, con los campos que usa el feed. Con ?accion=solo_verificar solo valida el pase y
// responde 204 sin datos. No revisa abierto_hasta: cerrar el acceso solo impide entradas nuevas.
// Cada video lleva hasta 50 comentarios (usuario, texto, foto_perfil_ruta, color) por creado_en, sin ids.
import { Entorno, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { PaseParticipante } from "../_shared/pase.ts";
import { VerificadorDeSesion } from "../_shared/sesiones.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "feed-videos";
// Sin titulo (interno) ni ruta_archivo (el video se pide aparte a video-firmado).
const COLUMNAS = [
  "id", "descripcion", "usuario", "foto_perfil_ruta", "sonido_nombre", "sonido_autor", "portada_sonido_ruta",
  "publicado_en", "me_gusta_num", "comentarios_num", "guardados_num",
  "enlace_activo", "enlace_texto", "enlace_url", "enlace_color",
].join(",");
const COLUMNAS_COMENTARIO = ["usuario", "texto", "foto_perfil_ruta", "color"] as const;
const MAX_COMENTARIOS = 50;

/** Comentarios de un video (solo lectura), sin id, video_id ni creado_en. */
async function comentariosDe(servicio: ClienteRest, videoId: string): Promise<Record<string, unknown>[]> {
  const filas = await servicio.consultar("comentarios", {
    select: COLUMNAS_COMENTARIO.join(","),
    video_id: `eq.${videoId}`,
    order: "creado_en.asc,id.asc",
    limit: String(MAX_COMENTARIOS),
  });
  return filas.slice(0, MAX_COMENTARIOS).map((f) => Object.fromEntries(COLUMNAS_COMENTARIO.map((c) => [c, f[c] ?? null])));
}

export async function manejar(peticion: Request, leer: LectorEntorno): Promise<Response> {
  const entorno = new Entorno(leer);
  let canal: CanalHttp;
  try {
    canal = new CanalHttp(entorno.requerido("ORIGEN_PERMITIDO"), ["GET"]);
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return new Response(null, { status: 500 });
  }
  const corte = canal.filtrar(peticion);
  if (corte) return corte;

  try {
    const accion = new URL(peticion.url).searchParams.get("accion");
    if (accion !== null && accion !== "solo_verificar") return canal.json(400, { error: "solicitud_invalida" });

    const servicio = ClienteRest.deServicio(entorno);
    const sesion = new VerificadorDeSesion(new PaseParticipante(entorno.secreto("TOKEN_SECRETO")), servicio);
    // 401 si el pase no vale (vencido, revocado, sin fila); 403 si aún no aceptó el aviso ni dio sus datos.
    const rechazo = await sesion.rechazo(CanalHttp.bearer(peticion));
    if (rechazo) return canal.json(rechazo.estado, { error: rechazo.error });
    if (accion === "solo_verificar") return canal.vacio(204);

    const videos = await servicio.consultar("videos", {
      select: COLUMNAS,
      publicado: "eq.true",
      order: "publicado_en.asc.nullslast,id.asc",
    });
    // Una consulta por video con su propio límite: ningún video se queda sin sus comentarios.
    const conComentarios = await Promise.all(videos.map(async (v) => ({
      ...v,
      comentarios: typeof v.id === "string" ? await comentariosDe(servicio, v.id) : [],
    })));
    return canal.json(200, conComentarios);
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
