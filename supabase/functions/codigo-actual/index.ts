// Edge Function "codigo-actual" (solo administrador).
// Devuelve el código de la ventana actual, los segundos que le quedan (hora del servidor) y hasta
// cuándo está abierto el acceso. Con { accion: "abrir" | "cerrar" } cambia config_acceso usando el
// JWT del administrador, para que se apliquen sus reglas RLS.
import { Entorno, ErrorControlado, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { GeneradorDeCodigo } from "../_shared/codigo.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "codigo-actual";
const HORAS_ABIERTO = 4;
const ACCIONES = new Set(["consultar", "abrir", "cerrar"]);
const PATRON_APIKEY = /^(sb_publishable_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_\-.]+)$/;

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
    // 1) Solo el administrador: JWT verificado por Supabase Auth y comparado con ADMIN_UID.
    const jwt = CanalHttp.bearer(peticion);
    const apikey = peticion.headers.get("apikey") ?? entorno.opcional("SUPABASE_ANON_KEY") ?? "";
    if (!jwt || !PATRON_APIKEY.test(apikey)) return canal.json(401, { error: "no_autorizado" });
    const comoAdmin = new ClienteRest(entorno.urlProyecto(), apikey, jwt);
    const usuario = await comoAdmin.usuarioActual();
    if (!usuario || !GeneradorDeCodigo.iguales(usuario.id, entorno.requerido("ADMIN_UID"))) {
      return canal.json(401, { error: "no_autorizado" });
    }

    // 2) Acción pedida (por defecto, solo consultar).
    const cuerpo = await CanalHttp.leerJson(peticion, 1024).catch(() => { throw new ErrorControlado("cuerpo_invalido"); });
    const accion = (cuerpo as { accion?: unknown } | null)?.accion ?? "consultar";
    if (typeof accion !== "string" || !ACCIONES.has(accion)) return canal.json(400, { error: "solicitud_invalida" });

    const ahora = Date.now();
    let filas;
    if (accion === "consultar") {
      filas = await comoAdmin.consultar("config_acceso", { select: "abierto_hasta", id: "eq.1" });
    } else {
      const abiertoHasta = accion === "abrir" ? new Date(ahora + HORAS_ABIERTO * 3600_000).toISOString() : null;
      filas = await comoAdmin.actualizar("config_acceso", { id: "eq.1", select: "abierto_hasta" },
        { abierto_hasta: abiertoHasta, actualizado_en: new Date(ahora).toISOString() });
    }
    if (filas.length !== 1) throw new ErrorControlado("config_acceso_sin_fila");
    const abiertoHasta = filas[0].abierto_hasta ?? null;

    // 3) Código de la ventana actual según la hora del servidor.
    const generador = new GeneradorDeCodigo(entorno.secreto("CODIGO_SECRETO"));
    return canal.json(200, {
      codigo: await generador.codigo(GeneradorDeCodigo.ventanaDe(ahora)),
      segundos_restantes: Math.round(GeneradorDeCodigo.segundosRestantes(ahora) * 1000) / 1000,
      abierto_hasta: abiertoHasta,
      ahora: new Date(ahora).toISOString(),
    });
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
