// Edge Function "feed-videos" (pública con pase). Con un pase de participante válido (y emitido
// después del último cierre de sesiones) y la sesión registrada devuelve { etapa, posicion, total, videos }.
// En la etapa "ciega", videos trae solo el video actual y el siguiente del orden guardado del participante
// (orden_ciego[posicion] y [posicion+1]), nunca el orden completo ni ids de otros videos; si el actual no
// está disponible, la lista va vacía. En cualquier otra etapa la lista va vacía. Con ?accion=solo_verificar
// solo valida el pase y responde 204 sin datos. No revisa abierto_hasta: cerrar el acceso solo impide
// entradas nuevas. Cada video lleva hasta 50 comentarios (usuario, texto, foto_perfil_ruta, color) por
// creado_en, sin ids.
import { Entorno, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { PaseParticipante } from "../_shared/pase.ts";
import { VerificadorDeSesion } from "../_shared/sesiones.ts";
import { ParticipanteActual } from "../_shared/participante-actual.ts";
import { FaseCiega } from "../_shared/progreso.ts";
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
    const token = CanalHttp.bearer(peticion);
    // 401 si el pase no vale (vencido, revocado, sin fila); 403 si aún no aceptó el aviso ni dio sus datos.
    if (accion === "solo_verificar") {
      const rechazo = await new VerificadorDeSesion(new PaseParticipante(entorno.secreto("TOKEN_SECRETO")), servicio).rechazo(token);
      return rechazo ? canal.json(rechazo.estado, { error: rechazo.error }) : canal.vacio(204);
    }
    const participante = await new ParticipanteActual(entorno, servicio).abrir(token);
    if ("rechazo" in participante) return canal.json(participante.rechazo.estado, { error: participante.rechazo.error });
    const { progreso } = participante;

    const ids = FaseCiega.visibles(progreso);
    const filas = ids.length
      ? await servicio.consultar("videos", { select: COLUMNAS, publicado: "eq.true", id: `in.(${ids.join(",")})` })
      : [];
    // En el orden guardado y solo los pedidos; si falta el actual, no se entrega ninguno.
    const porId = new Map(filas.map((f) => [String(f.id).toLowerCase(), f]));
    const videos = porId.has(ids[0]) ? ids.filter((id) => porId.has(id)).map((id) => porId.get(id)!) : [];
    // Una consulta por video con su propio límite: ningún video se queda sin sus comentarios.
    const conComentarios = await Promise.all(videos.map(async (v) => ({
      ...v,
      comentarios: typeof v.id === "string" ? await comentariosDe(servicio, v.id) : [],
    })));
    return canal.json(200, {
      etapa: progreso.etapa, posicion: progreso.posicion, total: progreso.orden.length, videos: conComentarios,
    });
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
