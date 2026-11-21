// Edge Function "registrar-visualizacion" (pública con pase). Recibe la medición del video actual de la
// fase a ciegas { video_id, tiempo_pantalla_ms, reproduccion_ms, completo }. Solo vale si la etapa es
// "ciega" y video_id es exactamente orden_ciego[posicion_ciega]. Inserta la fila en public.visualizaciones
// (fase "ciega", posicion = posicion_ciega + 1) y luego avanza posicion_ciega con una actualización
// condicionada al valor anterior; al llegar al final, la etapa pasa a "conoce". Si la fila ya existía,
// rechazo genérico sin avanzar. Si no se pudo avanzar, se borra la fila recién insertada.
// Responde 200 con { etapa, posicion, total } y nada más. Nunca se registran pases, códigos ni IPs.
import { Entorno, ErrorConflicto, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { ParticipanteActual } from "../_shared/participante-actual.ts";
import { FaseCiega, type Progreso, RegistroDeProgreso } from "../_shared/progreso.ts";
import { RegistroDeVisualizaciones, ValidadorDeVisualizacion } from "../_shared/visualizaciones.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "registrar-visualizacion";
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

    // 2) Cuerpo exacto.
    let cuerpo: unknown;
    try {
      cuerpo = await CanalHttp.leerJson(peticion, MAX_CUERPO_BYTES);
    } catch {
      return canal.rechazo();
    }
    const visualizacion = ValidadorDeVisualizacion.validar(cuerpo);
    if (!visualizacion) return canal.rechazo();

    // 3) Solo el video actual de la fase a ciegas.
    if (FaseCiega.actual(progreso) !== visualizacion.video_id) return canal.rechazo();
    const anterior = progreso.posicion;
    const ahora = Date.now();

    // 4) Una sola fila por video y fase: si ya existe, rechazo sin avanzar.
    const visualizaciones = new RegistroDeVisualizaciones(servicio);
    try {
      await visualizaciones.insertar(codigo, visualizacion, "ciega", anterior + 1, ahora);
    } catch (e) {
      if (e instanceof ErrorConflicto) return canal.rechazo();
      throw e;
    }

    // 5) Avance condicionado. Si la respuesta se perdió, se relee para saber si sí avanzó; si no avanzó,
    //    se deshace la fila para que el participante pueda volver a enviar este mismo video.
    const registro = new RegistroDeProgreso(servicio);
    let nuevo: Progreso | null = null;
    let fallo: unknown = null;
    try {
      nuevo = await registro.avanzarCiega(codigo, anterior, progreso.orden.length, ahora);
    } catch (e) {
      fallo = e;
      const releido = await registro.leer(codigo).catch(() => null);
      if (releido && releido.posicion === anterior + 1) nuevo = releido;
    }
    if (!nuevo) {
      await visualizaciones.borrar(codigo, visualizacion.video_id, "ciega").catch((e) => CanalHttp.registrarError(FUNCION, e));
      if (fallo) throw fallo;
      return canal.rechazo();
    }
    return canal.json(200, { etapa: nuevo.etapa, posicion: nuevo.posicion, total: nuevo.orden.length });
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
