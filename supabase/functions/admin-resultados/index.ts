// Edge Function "admin-resultados" (solo administrador). Entrega la base de análisis de «Resultados»
// (parte 1). Verifica la sesión igual que admin-datos (JWT verificado por Supabase Auth y comparado con
// ADMIN_UID; falla cerrada) y lee con la clave de servicio, que nunca sale de aquí. Solo marca exclusiones:
// no las aplica ni calcula aciertos, d′, c ni certeza (parte 2). Nunca lee ni devuelve nombre ni matrícula.
//
// Petición: POST, JSON de máx. 1 KB, exactamente { "accion": "base" }.
//
// Respuesta 200 (contrato, versión 1):
// {
//   version: 1,                       // sube solo si cambia un campo, su tipo o su significado
//   generado_en: string,              // ISO 8601, momento de la lectura
//   resumen: {
//     participantes: integer,         // códigos distintos con al menos una fila
//     participantes_registrados: int, // filas de perfil_participante (incluye a quien no llegó a responder)
//     filas: integer,                 // = filas.length
//     videos: integer,                // numero_video distintos en las filas
//     videos_sin_clasificar: integer, // de esos, cuántos no tienen origen o tipo
//     numeros_sin_clasificar: int[],  // sus numero_video, ascendente
//     filas_sin_numero_video: integer // filas cuyo video ya no existe o no tiene número
//   },
//   filas: [{                         // una por participante × video con al menos una respuesta;
//                                     // orden: codigo_participante, numero_video (nulos al final)
//     codigo_participante: string,    // "P-XXXXXXXX", anónimo
//     numero_video: integer | null,   // videos.numero_video; null si el video ya no existe o no tiene número
//     origen: "real" | "ia" | null,   // clasificacion_videos; null = sin clasificar
//     tipo: "ingenieria_social" | "normal" | null,
//     marco_deepfake_p8: boolean | null, // respuestas_video pregunta "deepfake" (paso 8); null = sin respuesta
//     obedeceria: boolean | null,     // respuestas_video pregunta "haria" («¿harías lo que te pide?»)
//     escala_p9: integer 1–6 | null,  // respuestas_evaluacion (paso 9): 1 = seguro real, 6 = seguro IA
//     carrera: string | null,         // perfil_participante
//     edad: integer | null,
//     semestre: integer | null,
//     deepfakes_previos: boolean | null, // null = no llegó a responder
//     excl_conoce_actor: boolean,     // por fila: respuestas_conoce.conoce = true para el actor de ese video
//                                     // (videos.actor_id); false si el video no tiene actor
//     excl_sesion_incompleta: boolean,// por participante: progreso_participante.etapa no es exposicion,
//                                     // resultado ni fin (no terminó el paso 9) o no hay fila de progreso
//     excl_retiro: boolean            // por participante: su código está en retiros_participante
//   }]
// }
// Errores (cuerpo { error }): 400 solicitud_invalida, 401 no_autorizado, 403 origen_no_permitido,
// 405 metodo_no_permitido, 413 demasiadas_filas, 503 falta_tabla_retiros (no se ha creado
// retiros_participante) o servicio_no_disponible. Nunca registra códigos, ids, respuestas ni tokens.
import { Entorno, ErrorControlado, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { VerificadorDeAdministrador } from "../_shared/administrador.ts";
import { ConstructorDeBase, LectorDeResultados } from "../_shared/base-analisis.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "admin-resultados";
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
    // 1) Solo el administrador: sin su sesión no se lee nada.
    if (!(await new VerificadorDeAdministrador(entorno).verificar(peticion))) return canal.json(401, { error: "no_autorizado" });

    // 2) Cuerpo exacto.
    let cuerpo: unknown;
    try {
      cuerpo = await CanalHttp.leerJson(peticion, MAX_CUERPO_BYTES);
    } catch {
      return canal.rechazo();
    }
    if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) return canal.rechazo();
    const c = cuerpo as Record<string, unknown>;
    if (Object.keys(c).length !== 1 || c.accion !== "base") return canal.rechazo();

    // 3) La base, con la clave de servicio (ya se verificó al administrador).
    const base = await new ConstructorDeBase(new LectorDeResultados(ClienteRest.deServicio(entorno))).construir(Date.now());
    return canal.json(200, base);
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    if (e instanceof ErrorControlado && e.message === "demasiadas_filas") return canal.json(413, { error: "demasiadas_filas" });
    if (e instanceof ErrorControlado && e.message === "falta_tabla_retiros") return canal.json(503, { error: "falta_tabla_retiros" });
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
