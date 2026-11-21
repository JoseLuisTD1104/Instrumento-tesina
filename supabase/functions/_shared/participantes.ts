// Datos de identificación de los participantes (tabla public.participantes, separada de la prueba).
// Solo la clave de servicio accede a la tabla. Ningún dato personal se devuelve ni se registra en logs.
import { ErrorConflicto, ErrorControlado } from "./entorno.ts";
import { ClienteRest } from "./supabase.ts";

/** Versión vigente del aviso de privacidad. El feed debe enviar exactamente este valor. */
export const VERSION_AVISO = "aviso-2026-11";

export type DatosParticipante = {
  matricula: string; nombre: string; carrera: string; version_terminos: string; edad: number; semestre: number;
};

/** Reglas de los datos que escribe el participante (las mismas que aplica la base). */
export class ValidadorDeParticipante {
  static PROHIBIDOS = /[<>"&]/;
  static CONTROL = /\p{Cc}/u;

  /** Limpia espacios y unifica la forma Unicode. */
  static #texto(valor: unknown): string {
    return typeof valor === "string" ? valor.normalize("NFC").replace(/\s+/g, " ").trim() : "";
  }

  static #entero(valor: unknown, minimo: number, maximo: number): valor is number {
    return typeof valor === "number" && Number.isInteger(valor) && valor >= minimo && valor <= maximo;
  }

  static #textoValido(texto: string, maximo: number): boolean {
    const largo = [...texto].length;
    return largo >= 1 && largo <= maximo && !ValidadorDeParticipante.PROHIBIDOS.test(texto) && !ValidadorDeParticipante.CONTROL.test(texto);
  }

  /** Devuelve los datos normalizados o la lista de campos inválidos (solo nombres de campo, sin valores). */
  static validar(cuerpo: unknown): { datos: DatosParticipante } | { campos: string[] } {
    const c = (cuerpo ?? {}) as Record<string, unknown>;
    const matricula = typeof c.matricula === "string" ? c.matricula.trim().toUpperCase() : "";
    const nombre = ValidadorDeParticipante.#texto(c.nombre);
    const carrera = ValidadorDeParticipante.#texto(c.carrera);
    const version = c.version_terminos;
    const { edad, semestre } = c;
    const campos: string[] = [];
    if (!/^[A-Z0-9]{6,15}$/.test(matricula)) campos.push("matricula");
    if (!ValidadorDeParticipante.#textoValido(nombre, 40)) campos.push("nombre");
    if (!ValidadorDeParticipante.#textoValido(carrera, 60)) campos.push("carrera");
    if (!ValidadorDeParticipante.#entero(edad, 17, 99)) campos.push("edad");
    if (!ValidadorDeParticipante.#entero(semestre, 1, 14)) campos.push("semestre");
    if (version !== VERSION_AVISO) campos.push("version_terminos");
    if (campos.length) return { campos };
    return { datos: { matricula, nombre, carrera, version_terminos: VERSION_AVISO, edad: edad as number, semestre: semestre as number } };
  }
}

/**
 * Código de participante anónimo: "P-" + 8 caracteres de un alfabeto sin I, O, 0 ni 1.
 * El alfabeto tiene exactamente 32 símbolos y 256 es múltiplo de 32, así que (byte & 31) elige cada
 * símbolo con la misma probabilidad: no hay sesgo y no hace falta descartar bytes.
 */
export class GeneradorCodigoParticipante {
  static ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  static LARGO = 8;
  static PATRON = /^P-[A-HJ-NP-Z2-9]{8}$/;

  static nuevo(): string {
    if (GeneradorCodigoParticipante.ALFABETO.length !== 32) throw new ErrorControlado("alfabeto_invalido");
    const bytes = crypto.getRandomValues(new Uint8Array(GeneradorCodigoParticipante.LARGO));
    return "P-" + Array.from(bytes, (b) => GeneradorCodigoParticipante.ALFABETO[b & 31]).join("");
  }
}

export class RegistroDeParticipantes {
  static INTENTOS = 3;

  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  /**
   * Inserta al participante con un código nuevo. Si el código se repite (409), reintenta con otro hasta
   * 3 veces en total; si aun así falla, lanza. Devuelve el código solo para uso interno del servidor.
   */
  async crear(datos: DatosParticipante, sesionNumero: number, ahoraMs: number): Promise<string> {
    for (let intento = 1; intento <= RegistroDeParticipantes.INTENTOS; intento++) {
      const codigo = GeneradorCodigoParticipante.nuevo();
      try {
        await this.#servicio.insertar("participantes", {
          codigo_participante: codigo,
          sesion_numero: sesionNumero,
          matricula: datos.matricula,
          nombre: datos.nombre,
          carrera: datos.carrera,
          version_terminos: datos.version_terminos,
          acepto_en: new Date(ahoraMs).toISOString(),
        });
        return codigo;
      } catch (e) {
        if (!(e instanceof ErrorConflicto) || intento === RegistroDeParticipantes.INTENTOS) throw e;
      }
    }
    throw new ErrorControlado("codigo_participante_agotado");
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

  /** Deshace un registro (si después no se pudo marcar la sesión), para no dejar datos huérfanos. */
  async borrar(codigo: string): Promise<void> {
    await this.#servicio.borrar("participantes", { codigo_participante: `eq.${codigo}` });
  }
}
