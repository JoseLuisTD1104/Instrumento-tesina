// Datos de la prueba que da el participante (tabla public.perfil_participante): carrera, edad, semestre y si
// antes había visto o escuchado deepfakes (deepfakes_previos),
// ligados solo al código anónimo, separados de la identidad. Solo la clave de servicio accede a la tabla.
// Ningún valor se devuelve ni se registra en logs.
import { ClienteRest } from "./supabase.ts";

export type DatosPerfil = { carrera: string; edad: number; semestre: number };

export class RegistroDePerfil {
  #servicio: ClienteRest;

  constructor(servicio: ClienteRest) {
    this.#servicio = servicio;
  }

  async crear(codigo: string, datos: DatosPerfil): Promise<void> {
    await this.#servicio.insertar("perfil_participante", {
      codigo_participante: codigo, carrera: datos.carrera, edad: datos.edad, semestre: datos.semestre,
    });
  }

  /** Guarda deepfakes_previos solo si aún no se había respondido (actualización condicionada). true si se guardó. */
  async guardarDeepfakesPrevios(codigo: string, si: boolean): Promise<boolean> {
    const filas = await this.#servicio.actualizar("perfil_participante",
      { codigo_participante: `eq.${codigo}`, deepfakes_previos: "is.null", select: "codigo_participante" }, { deepfakes_previos: si });
    return filas.length === 1;
  }

  /** Deshace la respuesta si después no se pudo avanzar la etapa. */
  async borrarDeepfakesPrevios(codigo: string): Promise<void> {
    await this.#servicio.actualizar("perfil_participante",
      { codigo_participante: `eq.${codigo}`, select: "codigo_participante" }, { deepfakes_previos: null });
  }

  async borrar(codigo: string): Promise<void> {
    await this.#servicio.borrar("perfil_participante", { codigo_participante: `eq.${codigo}` });
  }
}
