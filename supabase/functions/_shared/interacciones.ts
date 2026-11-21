// Métricas de interacción del feed (tabla public.interacciones, independiente de la identidad).
// Cada fila lleva solo el código anónimo del participante, que se obtiene en el servidor a partir de la
// sesión del pase: nunca se acepta desde el cliente. Ningún código ni dato personal va a los logs.
import { ErrorControlado } from "./entorno.ts";
import { GeneradorCodigoParticipante } from "./participantes.ts";
import { ClienteRest } from "./supabase.ts";

export type Interaccion = {
  video_id: string;
  tipo: string;
  tiempo_video_ms: number;
  detalle?: string;
  duracion_ms?: number;
};

/** Reglas de una interacción. Cualquier campo de más, de menos o fuera de rango la invalida. */
export class ValidadorDeInteraccion {
  static TIPOS = new Set([
    "me_gusta", "quitar_me_gusta", "guardar", "quitar_guardar", "comentarios",
    "compartir", "compartir_cerrado", "ver_enlace", "ver_enlace_cerrado", "mas_opciones",
    "seguir", "dejar_seguir", "pausa", "reanudar", "silenciar", "activar_sonido",
  ]);
  /** Solo los cierres de las ventanas simuladas llevan detalle y duración. */
  static TIPOS_DE_CIERRE = new Set(["compartir_cerrado", "ver_enlace_cerrado"]);
  static DETALLES = new Set(["manual", "automatico"]);
  static CAMPOS = new Set(["video_id", "tipo", "tiempo_video_ms", "detalle", "duracion_ms"]);
  static PATRON_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  static MAX_TIEMPO_MS = 3_600_000;
  static MAX_DURACION_MS = 60_000;

  static #entero(valor: unknown, maximo: number): valor is number {
    return typeof valor === "number" && Number.isInteger(valor) && valor >= 0 && valor <= maximo;
  }

  /** La interacción normalizada, o null si no cumple exactamente las reglas. */
  static validar(cuerpo: unknown): Interaccion | null {
    if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) return null;
    const c = cuerpo as Record<string, unknown>;
    if (Object.keys(c).some((k) => !ValidadorDeInteraccion.CAMPOS.has(k))) return null; // p. ej., codigo_participante
    const { video_id, tipo, tiempo_video_ms, detalle, duracion_ms } = c;
    if (typeof video_id !== "string" || !ValidadorDeInteraccion.PATRON_ID.test(video_id)) return null;
    if (typeof tipo !== "string" || !ValidadorDeInteraccion.TIPOS.has(tipo)) return null;
    if (!ValidadorDeInteraccion.#entero(tiempo_video_ms, ValidadorDeInteraccion.MAX_TIEMPO_MS)) return null;
    const interaccion: Interaccion = { video_id: video_id.toLowerCase(), tipo, tiempo_video_ms };
    const esCierre = ValidadorDeInteraccion.TIPOS_DE_CIERRE.has(tipo);
    if (detalle !== undefined) {
      if (!esCierre || typeof detalle !== "string" || !ValidadorDeInteraccion.DETALLES.has(detalle)) return null;
      interaccion.detalle = detalle;
    }
    if (duracion_ms !== undefined) {
      if (!esCierre || !ValidadorDeInteraccion.#entero(duracion_ms, ValidadorDeInteraccion.MAX_DURACION_MS)) return null;
      interaccion.duracion_ms = duracion_ms;
    }
    return interaccion;
  }
}

export class RegistroDeInteracciones {
  static LIMITE = 120;
  static VENTANA_MS = 60_000;

  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  /** Código anónimo del participante de esa sesión (sesiones_activas.numero → participantes.sesion_numero), o null. */
  async codigoDeSesion(sesionNumero: number): Promise<string | null> {
    const filas = await this.#servicio.consultar("participantes", {
      select: "codigo_participante", sesion_numero: `eq.${sesionNumero}`, limit: "2",
    });
    if (filas.length !== 1) return null;
    const codigo = filas[0].codigo_participante;
    return typeof codigo === "string" && GeneradorCodigoParticipante.PATRON.test(codigo) ? codigo : null;
  }

  /** true si el video existe y está publicado. */
  async videoPublicado(videoId: string): Promise<boolean> {
    const filas = await this.#servicio.consultar("videos", { select: "id", id: `eq.${videoId}`, publicado: "eq.true", limit: "1" });
    return filas.length === 1;
  }

  /** true si el participante aún no llega a 120 interacciones en los últimos 60 s. */
  async dentroDelLimite(codigo: string, ahoraMs: number): Promise<boolean> {
    const total = await this.#servicio.contar("interacciones", {
      codigo_participante: `eq.${codigo}`,
      creado_en: `gte.${new Date(ahoraMs - RegistroDeInteracciones.VENTANA_MS).toISOString()}`,
    });
    return total < RegistroDeInteracciones.LIMITE;
  }

  async insertar(codigo: string, interaccion: Interaccion, ahoraMs: number): Promise<void> {
    if (!GeneradorCodigoParticipante.PATRON.test(codigo)) throw new ErrorControlado("codigo_participante_invalido");
    await this.#servicio.insertar("interacciones", {
      codigo_participante: codigo,
      ...interaccion,
      creado_en: new Date(ahoraMs).toISOString(),
    });
  }
}
