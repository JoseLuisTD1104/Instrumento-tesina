// Edge Function "registrar-participante" (pública con pase). Recibe los datos de identificación del
// participante (matrícula, nombre de pila, carrera), su edad y semestre, la versión del aviso y su
// aceptación (acepto: true). Guarda la identidad en public.participantes con un código anónimo generado
// aquí; con ese código, carrera, edad y semestre en public.perfil_participante; y en
// public.progreso_participante la etapa "instruccion" con el orden de la fase a ciegas, mezclado aquí
// (Fisher-Yates con crypto.getRandomValues). Solo si todo eso tuvo éxito marca la sesión como registrada
// (con su nombre, lo único que ve el panel); si algo falla, borra lo insertado y responde el rechazo
// genérico. No devuelve ni registra ningún dato personal ni el código.
// Con { accion: "estado" } solo responde si el pase sigue valiendo (401 si no) y si ya se registró.
import { Entorno, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { PaseParticipante } from "../_shared/pase.ts";
import { RegistroDeSesiones, VerificadorDeSesion } from "../_shared/sesiones.ts";
import { RegistroDeParticipantes, ValidadorDeParticipante } from "../_shared/participantes.ts";
import { RegistroDePerfil } from "../_shared/perfil.ts";
import { RegistroDeProgreso } from "../_shared/progreso.ts";
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

    // 2) Aceptación explícita; si falta, rechazo genérico. Luego datos y versión del aviso: solo se
    //    informa qué campos fallaron, nunca sus valores.
    if ((cuerpo as { acepto?: unknown } | null)?.acepto !== true) return canal.rechazo();
    const resultado = ValidadorDeParticipante.validar(cuerpo);
    if ("campos" in resultado) return canal.json(400, { error: "datos_invalidos", campos: resultado.campos });
    const { datos } = resultado;

    // 3) Orden de la fase a ciegas (lanza si no hay videos publicados), antes de insertar nada.
    const ahora = Date.now();
    const progreso = new RegistroDeProgreso(servicio);
    const orden = await progreso.ordenAleatorio();

    // 4) Participante, perfil y progreso con el mismo código; solo si todo tuvo éxito, la sesión como
    //    registrada. Cada deshacer se apila antes de su inserción (borrar algo que no existe no daña).
    const participantes = new RegistroDeParticipantes(servicio);
    const perfil = new RegistroDePerfil(servicio);
    const codigo = await participantes.crear(datos, sesion.numero, ahora);
    const deshacer: (() => Promise<void>)[] = [() => participantes.borrar(codigo)];
    try {
      deshacer.unshift(() => perfil.borrar(codigo));
      await perfil.crear(codigo, { carrera: datos.carrera, edad: datos.edad, semestre: datos.semestre });
      deshacer.unshift(() => progreso.borrar(codigo));
      await progreso.crear(codigo, orden);
      await new RegistroDeSesiones(servicio).marcarRegistrada(sesion.numero, datos.nombre, ahora);
    } catch (e) {
      for (const paso of deshacer) await paso().catch((e2) => CanalHttp.registrarError(FUNCION, e2));
      throw e;
    }
    return canal.json(200, { ok: true });
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
