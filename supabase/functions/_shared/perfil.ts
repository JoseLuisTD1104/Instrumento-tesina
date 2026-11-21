// Datos de la prueba que da el participante (tabla public.perfil_participante): carrera, edad y semestre,
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

  async borrar(codigo: string): Promise<void> {
    await this.#servicio.borrar("perfil_participante", { codigo_participante: `eq.${codigo}` });
  }
}
