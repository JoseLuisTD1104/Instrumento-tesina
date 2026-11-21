// Edge Function "registrar-interaccion" (pública con pase). Guarda un toque del participante en el feed
// (me gusta, guardar, comentarios, compartir, enlace, "…", seguir, pausa, sonido) en public.interacciones,
// con el código anónimo que se obtiene aquí a partir de la sesión del pase. Solo acepta eventos en la
// etapa "ciega" y del video actual del participante. Responde 204 sin cuerpo.
// Todo rechazo de datos es el mismo 400 genérico; nunca se registran pases, códigos ni IPs.
import { Entorno, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { ParticipanteActual } from "../_shared/participante-actual.ts";
import { FaseCiega } from "../_shared/progreso.ts";
import { RegistroDeInteracciones, ValidadorDeInteraccion } from "../_shared/interacciones.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "registrar-interaccion";
const MAX_CUERPO_BYTES = 1024;

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
    // 1) Pase válido, sesión vigente y registrada (401 / 403 falta_registro, igual que feed-videos).
    const servicio = ClienteRest.deServicio(entorno);
    const participante = await new ParticipanteActual(entorno, servicio).abrir(CanalHttp.bearer(peticion));
    if ("rechazo" in participante) return canal.json(participante.rechazo.estado, { error: participante.rechazo.error });
    const { codigo, progreso } = participante;

    // 2) Cuerpo exacto: sin campos de más (el código del participante nunca viene del cliente).
    let cuerpo: unknown;
    try {
      cuerpo = await CanalHttp.leerJson(peticion, MAX_CUERPO_BYTES);
    } catch {
      return canal.rechazo();
    }
    const interaccion = ValidadorDeInteraccion.validar(cuerpo);
    if (!interaccion) return canal.rechazo();

    // 3) Solo el video actual de la fase a ciegas, publicado, y dentro del límite por minuto.
    if (FaseCiega.actual(progreso) !== interaccion.video_id) return canal.rechazo();
    const registro = new RegistroDeInteracciones(servicio);
    const ahora = Date.now();
    if (!(await registro.videoPublicado(interaccion.video_id))) return canal.rechazo();
    if (!(await registro.dentroDelLimite(codigo, ahora))) return canal.rechazo();

    // 4) Guardar.
    await registro.insertar(codigo, interaccion, ahora);
    return canal.vacio(204);
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
