"use strict";

/** Campos de un video. Se usa igual al subir y al editar. Todo texto se muestra con textContent. */
class FormularioVideo {
  static TEXTOS = ["titulo", "descripcion", "usuario", "sonido_nombre", "sonido_autor"];
  static IMAGENES = Object.freeze({
    foto: { columna: "foto_perfil_ruta", carpeta: "perfiles" },
    portada: { columna: "portada_sonido_ruta", carpeta: "portadas" },
  });

  #raiz;
  #repo;
  #videoOriginal = {};
  #instantaneaOriginal = "";
  #imagenes = { foto: { ruta: null, archivo: null }, portada: { ruta: null, archivo: null } };
  #alCambiar = () => {};

  constructor(contenedor, repo, prefijo) {
    this.#repo = repo;
    const copia = document.getElementById("tpl-formulario").content.cloneNode(true);
    this.#raiz = copia.firstElementChild;
    contenedor.replaceChildren(this.#raiz);

    // ids únicos para que cada etiqueta apunte a su campo
    this.#raiz.querySelectorAll("[data-campo]").forEach((el) => {
      el.id = `${prefijo}-${el.dataset.campo}`;
      const etiqueta = this.#raiz.querySelector(`label[data-para="${el.dataset.campo}"]`);
      if (etiqueta) etiqueta.htmlFor = el.id;
      el.addEventListener("input", () => { this.#actualizarContador(el.dataset.campo); this.#limpiarError(el.dataset.campo); this.#alCambiar(); });
    });
    for (const clave of Object.keys(FormularioVideo.IMAGENES)) {
      this.#raiz.querySelector(`[data-archivo="${clave}"]`).addEventListener("change", (e) => this.#elegirImagen(clave, e.currentTarget));
      this.#raiz.querySelector(`[data-quitar="${clave}"]`).addEventListener("click", () => {
        this.#imagenes[clave] = { ruta: null, archivo: null };
        this.#refrescarImagen(clave);
        this.#alCambiar();
      });
    }
    this.llenar({});
  }

  alCambiar(callback) { this.#alCambiar = callback; }

  /** Carga los datos de un video (o vacío). Las imágenes se reutilizan por su ruta, sin volver a subirlas. */
  llenar(video) {
    this.#videoOriginal = { ...video };
    for (const campo of FormularioVideo.TEXTOS) {
      this.#campo(campo).value = video[campo] ?? "";
      this.#actualizarContador(campo);
      this.#limpiarError(campo);
    }
    for (const [clave, { columna }] of Object.entries(FormularioVideo.IMAGENES)) {
      this.#imagenes[clave] = { ruta: video[columna] ?? null, archivo: null };
      this.#refrescarImagen(clave);
      this.#limpiarError(clave);
    }
    this.#instantaneaOriginal = this.#instantanea();
    this.#alCambiar();
  }

  restaurar() { this.llenar(this.#videoOriginal); }

  haCambiado() { return this.#instantanea() !== this.#instantaneaOriginal; }

  /** { textos normalizados, imagenes: { foto: {ruta, archivo}, portada: {...} } } */
  leer() {
    const crudo = {};
    for (const campo of FormularioVideo.TEXTOS) crudo[campo] = this.#campo(campo).value;
    return {
      textos: ValidadorVideo.normalizar(crudo),
      imagenes: { foto: { ...this.#imagenes.foto }, portada: { ...this.#imagenes.portada } },
    };
  }

  /** Valida y muestra los errores junto a cada campo. Devuelve true si todo está bien. */
  validar() {
    const errores = ValidadorVideo.validarTextos(this.leer().textos);
    for (const campo of FormularioVideo.TEXTOS) this.#mostrarError(campo, errores[campo] ?? "");
    const primero = FormularioVideo.TEXTOS.find((c) => errores[c]);
    if (primero) this.#campo(primero).focus();
    return !primero;
  }

  deshabilitar(si) { this.#raiz.disabled = si; }

  enfocar() { this.#campo("titulo").focus(); }

  // ------------------------------------------------------------------ internos
  #campo(nombre) { return this.#raiz.querySelector(`[data-campo="${nombre}"]`); }

  #instantanea() {
    const textos = this.leer().textos;
    const img = Object.fromEntries(Object.entries(this.#imagenes).map(([k, v]) => [
      k, { ruta: v.ruta, archivo: v.archivo ? `${v.archivo.name}|${v.archivo.size}|${v.archivo.lastModified}` : null },
    ]));
    return JSON.stringify({ textos, img });
  }

  #actualizarContador(campo) {
    const contador = this.#raiz.querySelector(`[data-contador="${campo}"]`);
    if (!contador) return;
    const max = ValidadorVideo.LIMITES[campo][1];
    const n = ValidadorVideo.largo(this.#campo(campo).value);
    contador.textContent = `${n}/${max}`;
    contador.classList.toggle("excedido", n > max);
  }

  #mostrarError(campo, texto) {
    const caja = this.#raiz.querySelector(`[data-error="${campo}"]`);
    if (caja) caja.textContent = texto;
    const el = this.#raiz.querySelector(`[data-campo="${campo}"]`);
    if (el) el.setAttribute("aria-invalid", texto ? "true" : "false");
  }

  #limpiarError(campo) { this.#mostrarError(campo, ""); }

  async #elegirImagen(clave, input) {
    const archivo = input.files?.[0];
    input.value = "";
    if (!archivo) return;
    try {
      await ValidadorVideo.validarImagen(archivo);
      this.#imagenes[clave] = { ruta: this.#imagenes[clave].ruta, archivo };
      this.#limpiarError(clave);
      this.#refrescarImagen(clave);
      this.#alCambiar();
    } catch (e) {
      this.#mostrarError(clave, e instanceof ErrorPanel ? e.message : "No se pudo leer la imagen.");
    }
  }

  #refrescarImagen(clave) {
    const { ruta, archivo } = this.#imagenes[clave];
    const img = this.#raiz.querySelector(`[data-vista="${clave}"]`);
    const estado = this.#raiz.querySelector(`[data-estado="${clave}"]`);
    const quitar = this.#raiz.querySelector(`[data-quitar="${clave}"]`);

    if (archivo) {
      img.hidden = true;
      img.removeAttribute("src");
      estado.textContent = `Se subirá al guardar: ${archivo.name} (${ValidadorVideo.tamano(archivo.size)})`;
    } else if (ruta) {
      img.src = this.#repo.urlPublica("imagenes", ruta);
      img.hidden = false;
      estado.textContent = "Imagen actual";
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      estado.textContent = "Sin imagen";
    }
    quitar.hidden = !archivo && !ruta;
  }
}

/** Diálogos modales del panel (confirmar y elegir un video). */
class Dialogos {
  #confirmar = document.getElementById("dialogo-confirmar");
  #duplicar = document.getElementById("dialogo-duplicar");

  confirmar(texto, textoAceptar = "Aceptar") {
    this.#confirmar.querySelector("[data-texto]").textContent = texto;
    this.#confirmar.querySelector("[data-aceptar]").textContent = textoAceptar;
    return this.#abrir(this.#confirmar).then((valor) => valor === "aceptar");
  }

  /** Muestra la lista de videos y resuelve con el elegido, o null si se cancela. */
  async elegirVideo(videos) {
    const lista = this.#duplicar.querySelector("[data-lista]");
    const vacio = this.#duplicar.querySelector("[data-vacio]");
    vacio.hidden = videos.length > 0;
    lista.replaceChildren(...videos.map((v, i) => {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "opcion-video";
      boton.value = String(i);
      const titulo = document.createElement("strong");
      titulo.textContent = v.titulo;
      const meta = document.createElement("span");
      meta.textContent = `${v.usuario ? `@${v.usuario}` : "sin @usuario"} · ${PanelFormato.fecha(v.creado_en)}`;
      boton.append(titulo, meta);
      boton.addEventListener("click", () => this.#duplicar.close(String(i)));
      return boton;
    }));
    const valor = await this.#abrir(this.#duplicar);
    const indice = Number.parseInt(valor, 10);
    return Number.isInteger(indice) && videos[indice] ? videos[indice] : null;
  }

  #abrir(dialogo) {
    return new Promise((resolver) => {
      dialogo.returnValue = "";
      dialogo.addEventListener("close", () => resolver(dialogo.returnValue), { once: true });
      dialogo.showModal();
    });
  }
}

/** Formatos compartidos por las pestañas. */
class PanelFormato {
  static fecha(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
  }

  static mensaje(caja, texto, tipo = "info") {
    caja.textContent = texto;
    caja.dataset.tipo = tipo;
    caja.hidden = !texto;
  }

  static errorVisible(e, generico) {
    return e instanceof ErrorPanel ? e.message : generico;
  }
}
