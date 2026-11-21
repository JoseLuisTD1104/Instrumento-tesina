// Edge Function "registrar-evaluacion" (pública con pase). Recibe la respuesta del video actual de la
// evaluación { video_id, respuesta, tiempo_pantalla_ms, reproduccion_ms, completo }, con respuesta entera de
// 1 a 6. Solo vale si la etapa es "evaluacion" y video_id es exactamente orden_evaluacion[posicion_evaluacion].
// Inserta la respuesta en public.respuestas_evaluacion y la medición en public.visualizaciones (fase
// "evaluacion"), ambas con posicion = posicion_evaluacion + 1; si una de las dos falla, se deshace la otra.
// Luego avanza posicion_evaluacion con una actualización condicionada al valor anterior; al llegar al final,
// la etapa pasa a "exposicion". Si no se pudo avanzar, se borran las dos filas. Si ya existían, rechazo
// genérico sin avanzar. Responde 200 con { etapa, posicion, total } y nada más.
// Nunca se registran pases, códigos, IPs ni respuestas.
import { Entorno, ErrorConflicto, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { ParticipanteActual } from "../_shared/participante-actual.ts";
import { FaseDeVideos, type Progreso, RegistroDeProgreso } from "../_shared/progreso.ts";
import { RegistroDeEvaluaciones, ValidadorDeEvaluacion } from "../_shared/evaluaciones.ts";
import { RegistroDeVisualizaciones } from "../_shared/visualizaciones.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "registrar-evaluacion";
const MAX_CUERPO_BYTES = 1024;
const FASE = "evaluacion";

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
    const evaluacion = ValidadorDeEvaluacion.validar(cuerpo);
    if (!evaluacion) return canal.rechazo();
    const { respuesta, visualizacion } = evaluacion;
    const videoId = visualizacion.video_id;

    // 3) Solo el video actual de la evaluación.
    if (FaseDeVideos.EVALUACION.actual(progreso) !== videoId) return canal.rechazo();
    const anterior = progreso.posicionEvaluacion;
    const total = progreso.ordenEvaluacion?.length ?? 0;
    const ahora = Date.now();

    // 4) Las dos filas, o ninguna. Una fila repetida (ya respondió este video): rechazo sin avanzar.
    const respuestas = new RegistroDeEvaluaciones(servicio);
    const visualizaciones = new RegistroDeVisualizaciones(servicio);
    try {
      await respuestas.insertar(codigo, videoId, respuesta, anterior + 1, ahora);
    } catch (e) {
      if (e instanceof ErrorConflicto) return canal.rechazo();
      throw e;
    }
    try {
      await visualizaciones.insertar(codigo, visualizacion, FASE, anterior + 1, ahora);
    } catch (e) {
      await respuestas.borrar(codigo, videoId).catch((e2) => CanalHttp.registrarError(FUNCION, e2));
      if (e instanceof ErrorConflicto) return canal.rechazo();
      throw e;
    }

    // 5) Avance condicionado. Si la respuesta se perdió, se relee para saber si sí avanzó; si no avanzó,
    //    se deshacen las dos filas para que el participante pueda volver a enviar este mismo video.
    const registro = new RegistroDeProgreso(servicio);
    let nuevo: Progreso | null = null;
    let fallo: unknown = null;
    try {
      nuevo = await registro.avanzarEvaluacion(codigo, anterior, total, ahora);
    } catch (e) {
      fallo = e;
      const releido = await registro.leer(codigo).catch(() => null);
      if (releido && releido.ordenEvaluacion && releido.posicionEvaluacion === anterior + 1) nuevo = releido;
    }
    if (!nuevo) {
      await Promise.all([
        respuestas.borrar(codigo, videoId).catch((e) => CanalHttp.registrarError(FUNCION, e)),
        visualizaciones.borrar(codigo, videoId, FASE).catch((e) => CanalHttp.registrarError(FUNCION, e)),
      ]);
      if (fallo) throw fallo;
      return canal.rechazo();
    }
    const avance = FaseDeVideos.EVALUACION.avance(nuevo);
    return canal.json(200, { etapa: nuevo.etapa, posicion: avance.posicion, total: avance.total });
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
