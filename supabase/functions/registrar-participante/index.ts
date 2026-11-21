// Edge Function "registrar-participante" (pública con pase). Recibe los datos de identificación del
// participante (matrícula, nombre de pila, carrera) y la versión del aviso que aceptó. Los guarda en
// public.participantes con un código anónimo generado aquí, y solo después marca la sesión como
// registrada (con su nombre, lo único que ve el panel). No devuelve ni registra ningún dato personal.
// Con { accion: "estado" } solo responde si el pase sigue valiendo (401 si no) y si ya se registró.
import { Entorno, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { PaseParticipante } from "../_shared/pase.ts";
import { RegistroDeSesiones, VerificadorDeSesion } from "../_shared/sesiones.ts";
import { RegistroDeParticipantes, ValidadorDeParticipante } from "../_shared/participantes.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "registrar-participante";
const MAX_CUERPO_BYTES = 2048;

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
    // 1) Pase válido y sesión vigente (sin exigir registro: justo eso se hace aquí).
    const servicio = ClienteRest.deServicio(entorno);
    const verificador = new VerificadorDeSesion(new PaseParticipante(entorno.secreto("TOKEN_SECRETO")), servicio);
    const sesion = await verificador.sesion(CanalHttp.bearer(peticion));
    if (!sesion) return canal.json(401, { error: "pase_invalido" });

    let cuerpo: unknown;
    try {
      cuerpo = await CanalHttp.leerJson(peticion, MAX_CUERPO_BYTES);
    } catch {
      return canal.json(400, { error: "solicitud_invalida" });
    }
    // { accion: "estado" }: solo dice si la sesión sigue viva y si ya se registró (lo usa el vigilante del
    // feed mientras el participante lee el aviso, sin provocar 403). No devuelve ningún dato personal.
    if ((cuerpo as { accion?: unknown } | null)?.accion === "estado") return canal.json(200, { registrada: sesion.registrada });
    if (sesion.registrada) return canal.json(200, { ok: true }); // ya registrada: no se duplica

    // 2) Datos y versión del aviso. Solo se informa qué campos fallaron, nunca sus valores.
    const resultado = ValidadorDeParticipante.validar(cuerpo);
    if ("campos" in resultado) return canal.json(400, { error: "datos_invalidos", campos: resultado.campos });

    // 3) Participante con código anónimo y, solo si eso tuvo éxito, la sesión como registrada.
    const ahora = Date.now();
    const participantes = new RegistroDeParticipantes(servicio);
    const codigo = await participantes.crear(resultado.datos, sesion.numero, ahora);
    try {
      await new RegistroDeSesiones(servicio).marcarRegistrada(sesion.numero, resultado.datos.nombre, ahora);
    } catch (e) {
      await participantes.borrar(codigo).catch((e2) => CanalHttp.registrarError(FUNCION, e2));
      throw e;
    }
    return canal.json(200, { ok: true });
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
