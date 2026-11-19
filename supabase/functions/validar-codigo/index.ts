// Edge Function "validar-codigo" (pública). Recibe { codigo } de 8 dígitos y, si es correcto y el
// acceso está abierto, entrega un pase de participante (JWT HS256, 3 h).
// Todo rechazo responde igual: mismo estado, mismo mensaje y una espera mínima fija.
import { Entorno, ErrorControlado, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { GeneradorDeCodigo } from "../_shared/codigo.ts";
import { PaseParticipante } from "../_shared/pase.ts";
import { HuellaDeRed } from "../_shared/red.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "validar-codigo";
const MAX_CUERPO_BYTES = 1024;
const ESPERA_MINIMA_MS = 400;
const MAX_FALLOS_RED = 30;
const VENTANA_FALLOS_RED_MS = 5 * 60_000;
const MAX_FALLOS_GLOBALES = 500;
const GRACIA_VENTANA_ANTERIOR_S = 60;
const RETENCION_INTENTOS_MS = 7 * 24 * 3600_000;
const MENSAJE_RECHAZO = "Código no válido";

export async function manejar(peticion: Request, leer: LectorEntorno): Promise<Response> {
  const inicio = Date.now();
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

  const rechazar = async (): Promise<Response> => {
    await CanalHttp.esperarHasta(inicio + ESPERA_MINIMA_MS);
    return canal.json(401, { error: MENSAJE_RECHAZO });
  };

  try {
    // Entrada: JSON de máx. 1 KB con "codigo" de exactamente 8 dígitos.
    const cuerpo = await CanalHttp.leerJson(peticion, MAX_CUERPO_BYTES);
    const codigo = (cuerpo as { codigo?: unknown } | null)?.codigo;
    if (typeof codigo !== "string" || !/^\d{8}$/.test(codigo)) return await rechazar();

    const servicio = ClienteRest.deServicio(entorno);
    const ahora = Date.now();

    // a) Acceso abierto y vigente.
    const config = await servicio.consultar("config_acceso", { select: "abierto_hasta", id: "eq.1" });
    const abiertoHasta = Date.parse(String(config[0]?.abierto_hasta ?? ""));
    if (config.length !== 1 || !Number.isFinite(abiertoHasta) || abiertoHasta <= ahora) return await rechazar();

    // b) Huella de red (sin guardar la IP).
    const huella = await new HuellaDeRed(entorno.secreto("IP_SECRETO")).de(peticion);

    // c) Límites: por red (últimos 5 min) y global (ventana actual). Sin comparar el código.
    const desdeRed = new Date(ahora - VENTANA_FALLOS_RED_MS).toISOString();
    const inicioVentana = new Date(GeneradorDeCodigo.ventanaDe(ahora) * GeneradorDeCodigo.PASO_S * 1000).toISOString();
    const [fallosRed, fallosGlobales] = await Promise.all([
      servicio.contar("intentos_acceso", { ip_hash: `eq.${huella}`, exito: "eq.false", creado_en: `gte.${desdeRed}` }),
      servicio.contar("intentos_acceso", { exito: "eq.false", creado_en: `gte.${inicioVentana}` }),
    ]);
    if (fallosRed >= MAX_FALLOS_RED || fallosGlobales >= MAX_FALLOS_GLOBALES) return await rechazar();

    // d) Código de la ventana actual y, solo en su primer minuto, el de la anterior. Siempre se
    //    calculan y comparan ambos para que el tiempo no dependa de cuál coincide.
    const generador = new GeneradorDeCodigo(entorno.secreto("CODIGO_SECRETO"));
    const ventana = GeneradorDeCodigo.ventanaDe(ahora);
    const [actual, anterior] = await Promise.all([generador.codigo(ventana), generador.codigo(ventana - 1)]);
    const enGracia = GeneradorDeCodigo.segundosEnVentana(ahora) < GRACIA_VENTANA_ANTERIOR_S;
    const coincideActual = GeneradorDeCodigo.iguales(codigo, actual);
    const coincideAnterior = GeneradorDeCodigo.iguales(codigo, anterior);
    const correcto = coincideActual || (enGracia && coincideAnterior);

    // e) Registro del intento (sin IP ni código) y limpieza de registros de más de 7 días.
    await servicio.insertar("intentos_acceso", { ip_hash: huella, exito: correcto });
    await servicio.borrar("intentos_acceso", { creado_en: `lt.${new Date(ahora - RETENCION_INTENTOS_MS).toISOString()}` })
      .catch((e) => CanalHttp.registrarError(FUNCION, e)); // la limpieza no decide el acceso

    if (!correcto) return await rechazar();

    // f) Pase de participante.
    const pase = await new PaseParticipante(entorno.secreto("TOKEN_SECRETO")).emitir(ahora);
    return canal.json(200, { pase, expira_en: PaseParticipante.DURACION_S });
  } catch (e) {
    // Falla cerrada: cualquier error es un rechazo idéntico a los demás.
    if (!(e instanceof SyntaxError) && !(e instanceof ErrorControlado && e.message === "cuerpo_grande")) {
      CanalHttp.registrarError(FUNCION, e);
    }
    return await rechazar();
  }
}

servir(manejar);
