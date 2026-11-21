// Edge Function "registrar-interaccion" (pública con pase). Guarda un toque del participante en el feed
// (me gusta, guardar, comentarios, compartir, enlace, "…", seguir, pausa, sonido) en public.interacciones,
// con el código anónimo que se obtiene aquí a partir de la sesión del pase. Responde 204 sin cuerpo.
// Todo rechazo de datos es el mismo 400 genérico; nunca se registran pases, códigos ni IPs.
import { Entorno, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { PaseParticipante } from "../_shared/pase.ts";
import { VerificadorDeSesion } from "../_shared/sesiones.ts";
import { RegistroDeInteracciones, ValidadorDeInteraccion } from "../_shared/interacciones.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "registrar-interaccion";
const MAX_CUERPO_BYTES = 1024;
const RECHAZO = { error: "solicitud_invalida" };

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
    const verificador = new VerificadorDeSesion(new PaseParticipante(entorno.secreto("TOKEN_SECRETO")), servicio);
    const sesion = await verificador.sesion(CanalHttp.bearer(peticion));
    if (!sesion) return canal.json(401, { error: "pase_invalido" });
    if (!sesion.registrada) return canal.json(403, { error: "falta_registro" });

    // 2) Cuerpo exacto: sin campos de más (el código del participante nunca viene del cliente).
    let cuerpo: unknown;
    try {
      cuerpo = await CanalHttp.leerJson(peticion, MAX_CUERPO_BYTES);
    } catch {
      return canal.json(400, RECHAZO);
    }
    const interaccion = ValidadorDeInteraccion.validar(cuerpo);
    if (!interaccion) return canal.json(400, RECHAZO);

    // 3) Código anónimo de la sesión, video publicado y límite por minuto.
    const registro = new RegistroDeInteracciones(servicio);
    const ahora = Date.now();
    const [codigo, publicado] = await Promise.all([
      registro.codigoDeSesion(sesion.numero),
      registro.videoPublicado(interaccion.video_id),
    ]);
    if (!codigo || !publicado) return canal.json(400, RECHAZO);
    if (!(await registro.dentroDelLimite(codigo, ahora))) return canal.json(400, RECHAZO);

    // 4) Guardar.
    await registro.insertar(codigo, interaccion, ahora);
    return canal.vacio(204);
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
