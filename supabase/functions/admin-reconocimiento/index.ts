// Edge Function "admin-reconocimiento" (solo administrador). Verifica la sesión igual que codigo-actual
// (JWT verificado por Supabase Auth y comparado con ADMIN_UID; falla cerrada). Solo POST con JSON de
// máx. 700 KB y { accion, ... }:
// - listar_actores: { actores: [{ id, alias, cara_url, videos }] } (URL firmada de 10 min, videos asignados).
// - listar_miniaturas: { miniaturas: [{ video_id, miniatura_url }] } para la vista previa del panel.
// - crear_actor { alias, imagen }, cambiar_cara { actor_id, imagen }, borrar_actor { actor_id } (se rechaza
//   si tiene videos asignados), subir_miniatura { video_id, imagen }, asignar_actor { video_id, actor_id | null }.
// imagen va en base64; el tipo (jpeg, png o webp) se decide por los bytes iniciales y no puede pasar de
// 400 KB ya decodificada. La ruta la genera el servidor; al reemplazar una imagen se borra la anterior.
// Errores con etiquetas fijas, sin datos. Nunca registra ids, alias, rutas ni tokens.
import { Entorno, ErrorConflicto, type LectorEntorno } from "../_shared/entorno.ts";
import { CanalHttp } from "../_shared/http.ts";
import { VerificadorDeAdministrador } from "../_shared/administrador.ts";
import { PATRON_UUID } from "../_shared/progreso.ts";
import {
  AlmacenDeReconocimiento, type Carpeta, RegistroDeActores, ValidadorDeAlias, ValidadorDeImagen, VideosDeReconocimiento,
} from "../_shared/reconocimiento.ts";
import { ClienteRest } from "../_shared/supabase.ts";
import { servir } from "../_shared/servidor.ts";

const FUNCION = "admin-reconocimiento";
const MAX_CUERPO_BYTES = 700 * 1024;

/** Campos que acepta cada acción (además de "accion"); cualquier otro invalida la petición. */
const CAMPOS: Record<string, string[]> = {
  listar_actores: [],
  listar_miniaturas: [],
  crear_actor: ["alias", "imagen"],
  cambiar_cara: ["actor_id", "imagen"],
  borrar_actor: ["actor_id"],
  subir_miniatura: ["video_id", "imagen"],
  asignar_actor: ["video_id", "actor_id"],
};

/** Resultado de una acción: estado HTTP y cuerpo. */
type Resultado = [number, Record<string, unknown>];
const INVALIDA: Resultado = [400, { error: "solicitud_invalida" }];
const IMAGEN_INVALIDA: Resultado = [400, { error: "imagen_invalida" }];
const NO_ENCONTRADO: Resultado = [404, { error: "no_encontrado" }];
const OK: Resultado = [200, { ok: true }];

function uuid(valor: unknown): string | null {
  return typeof valor === "string" && PATRON_UUID.test(valor) ? valor.toLowerCase() : null;
}

/** Cada acción del panel sobre actores, caras y miniaturas. */
class AccionesDeReconocimiento {
  #actores: RegistroDeActores;
  #videos: VideosDeReconocimiento;
  #almacen: AlmacenDeReconocimiento;

  constructor(servicio: ClienteRest) {
    this.#actores = new RegistroDeActores(servicio);
    this.#videos = new VideosDeReconocimiento(servicio);
    this.#almacen = new AlmacenDeReconocimiento(servicio);
  }

  async ejecutar(accion: string, c: Record<string, unknown>): Promise<Resultado> {
    switch (accion) {
      case "listar_actores": return await this.#listarActores();
      case "listar_miniaturas": return await this.#listarMiniaturas();
      case "crear_actor": return await this.#crearActor(c.alias, c.imagen);
      case "cambiar_cara": return await this.#cambiarCara(c.actor_id, c.imagen);
      case "borrar_actor": return await this.#borrarActor(c.actor_id);
      case "subir_miniatura": return await this.#subirMiniatura(c.video_id, c.imagen);
      case "asignar_actor": return await this.#asignarActor(c.video_id, c.actor_id);
      default: return INVALIDA;
    }
  }

  async #listarActores(): Promise<Resultado> {
    const [actores, videos] = await Promise.all([this.#actores.listar(), this.#videos.todos()]);
    const conteo = new Map<string, number>();
    for (const v of videos) if (v.actor_id) conteo.set(v.actor_id, (conteo.get(v.actor_id) ?? 0) + 1);
    const urls = await this.#almacen.firmar("caras", actores.map((a) => a.cara_ruta));
    return [200, {
      actores: actores.map((a) => ({ id: a.id, alias: a.alias, cara_url: urls.get(a.cara_ruta)!, videos: conteo.get(a.id) ?? 0 })),
    }];
  }

  async #listarMiniaturas(): Promise<Resultado> {
    const videos = (await this.#videos.todos()).filter((v) => v.miniatura_ruta);
    const urls = await this.#almacen.firmar("miniaturas", videos.map((v) => v.miniatura_ruta as string));
    return [200, { miniaturas: videos.map((v) => ({ video_id: v.id, miniatura_url: urls.get(v.miniatura_ruta as string)! })) }];
  }

  async #crearActor(aliasRecibido: unknown, imagenRecibida: unknown): Promise<Resultado> {
    const alias = ValidadorDeAlias.normalizar(aliasRecibido);
    if (!alias) return [400, { error: "alias_invalido" }];
    const imagen = ValidadorDeImagen.validar(imagenRecibida);
    if (!imagen) return IMAGEN_INVALIDA;
    const ruta = await this.#almacen.subir("caras", imagen);
    try {
      await this.#actores.crear(alias, ruta);
    } catch (e) {
      await this.#borrarSilencioso("caras", ruta);
      if (e instanceof ErrorConflicto) return [409, { error: "alias_repetido" }];
      throw e;
    }
    return OK;
  }

  async #cambiarCara(actorRecibido: unknown, imagenRecibida: unknown): Promise<Resultado> {
    const id = uuid(actorRecibido);
    if (!id) return INVALIDA;
    const imagen = ValidadorDeImagen.validar(imagenRecibida);
    if (!imagen) return IMAGEN_INVALIDA;
    const actor = await this.#actores.leer(id);
    if (!actor) return NO_ENCONTRADO;
    const nueva = await this.#almacen.subir("caras", imagen);
    if (!(await this.#reemplazar("caras", nueva, () => this.#actores.cambiarCara(id, actor.cara_ruta, nueva)))) {
      return [409, { error: "cambio_simultaneo" }];
    }
    await this.#borrarSilencioso("caras", actor.cara_ruta);
    return OK;
  }

  async #borrarActor(actorRecibido: unknown): Promise<Resultado> {
    const id = uuid(actorRecibido);
    if (!id) return INVALIDA;
    const actor = await this.#actores.leer(id);
    if (!actor) return NO_ENCONTRADO;
    if (await this.#videos.cuantosDelActor(id) > 0) return [409, { error: "actor_con_videos" }];
    try {
      await this.#actores.borrar(id); // la llave foránea (restrict) cubre una asignación simultánea
    } catch (e) {
      if (e instanceof ErrorConflicto) return [409, { error: "actor_con_videos" }];
      throw e;
    }
    await this.#borrarSilencioso("caras", actor.cara_ruta);
    return OK;
  }

  async #subirMiniatura(videoRecibido: unknown, imagenRecibida: unknown): Promise<Resultado> {
    const id = uuid(videoRecibido);
    if (!id) return INVALIDA;
    const imagen = ValidadorDeImagen.validar(imagenRecibida);
    if (!imagen) return IMAGEN_INVALIDA;
    const video = await this.#videos.leer(id);
    if (!video) return NO_ENCONTRADO;
    const nueva = await this.#almacen.subir("miniaturas", imagen);
    if (!(await this.#reemplazar("miniaturas", nueva, () => this.#videos.cambiarMiniatura(id, video.miniatura_ruta, nueva)))) {
      return [409, { error: "cambio_simultaneo" }];
    }
    if (video.miniatura_ruta) await this.#borrarSilencioso("miniaturas", video.miniatura_ruta);
    return [200, { ok: true, miniatura_ruta: nueva }];
  }

  async #asignarActor(videoRecibido: unknown, actorRecibido: unknown): Promise<Resultado> {
    const videoId = uuid(videoRecibido);
    const actorId = actorRecibido === null ? null : uuid(actorRecibido);
    if (!videoId || (actorRecibido !== null && !actorId)) return INVALIDA;
    if (actorId && !(await this.#actores.leer(actorId))) return NO_ENCONTRADO;
    return (await this.#videos.asignarActor(videoId, actorId)) ? OK : NO_ENCONTRADO;
  }

  /** Guarda la ruta nueva; si no se pudo (o falló), borra el objeto recién subido. */
  async #reemplazar(carpeta: Carpeta, nueva: string, guardar: () => Promise<boolean>): Promise<boolean> {
    let guardado = false;
    try {
      guardado = await guardar();
    } finally {
      if (!guardado) await this.#borrarSilencioso(carpeta, nueva);
    }
    return guardado;
  }

  /** Un objeto que no se pudo borrar no detiene la operación: queda huérfano, sin datos en el log. */
  async #borrarSilencioso(carpeta: Carpeta, ruta: string): Promise<void> {
    await this.#almacen.borrar(carpeta, [ruta]).catch((e) => CanalHttp.registrarError(FUNCION, e));
  }
}

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
    // 1) Solo el administrador.
    if (!(await new VerificadorDeAdministrador(entorno).verificar(peticion))) return canal.json(401, { error: "no_autorizado" });

    // 2) Acción y campos exactos.
    let cuerpo: unknown;
    try {
      cuerpo = await CanalHttp.leerJson(peticion, MAX_CUERPO_BYTES);
    } catch {
      return canal.rechazo();
    }
    if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) return canal.rechazo();
    const c = cuerpo as Record<string, unknown>;
    const accion = c.accion;
    const permitidos = typeof accion === "string" && Object.hasOwn(CAMPOS, accion) ? CAMPOS[accion] : null;
    const claves = Object.keys(c).filter((k) => k !== "accion");
    if (!permitidos || claves.length !== permitidos.length || !permitidos.every((k) => claves.includes(k))) return canal.rechazo();

    // 3) La acción, con la clave de servicio (ya se verificó al administrador).
    const [estado, respuesta] = await new AccionesDeReconocimiento(ClienteRest.deServicio(entorno)).ejecutar(accion as string, c);
    return canal.json(estado, respuesta);
  } catch (e) {
    CanalHttp.registrarError(FUNCION, e);
    return canal.json(503, { error: "servicio_no_disponible" });
  }
}

servir(manejar);
