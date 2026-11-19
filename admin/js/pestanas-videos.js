"use strict";

/** Sube las imágenes nuevas del formulario y devuelve las columnas de imagen para la fila. */
async function subirImagenesDelFormulario(repo, imagenes, subidos, alProgreso) {
  const columnas = {};
  for (const [clave, { columna, carpeta }] of Object.entries(FormularioVideo.IMAGENES)) {
    const { ruta, archivo } = imagenes[clave];
    if (archivo) {
      const ext = await ValidadorVideo.validarImagen(archivo);
      const nueva = repo.nuevaRuta(carpeta, ext);
      await repo.subirArchivo("imagenes", nueva, archivo, (n) => alProgreso(archivo, n));
      subidos.push(["imagenes", nueva]);
      columnas[columna] = nueva;
    } else {
      columnas[columna] = ruta ?? null;
    }
  }
  return columnas;
}

/** Pestaña "Subir videos": elegir archivo, llenar datos, subir. */
class PestanaSubir {
  #repo;
  #dialogos;
  #form;
  #archivo = null;
  #enviando = false;
  #alSubir = () => {};

  #inicio = document.getElementById("subir-inicio");
  #seccionForm = document.getElementById("subir-formulario");
  #zona = document.getElementById("dropzone");
  #selector = document.getElementById("selector");
  #nombreArchivo = document.getElementById("subir-archivo");
  #progreso = document.getElementById("subir-progreso");
  #mensaje = document.getElementById("subir-mensaje");
  #resultado = document.getElementById("subir-resultado");
  #botonEnviar = document.getElementById("subir-enviar");
  #botonCancelar = document.getElementById("subir-cancelar");
  #botonDuplicar = document.getElementById("subir-duplicar");

  constructor(repo, dialogos) {
    this.#repo = repo;
    this.#dialogos = dialogos;
    this.#form = new FormularioVideo(document.getElementById("subir-campos"), repo, "subir");
  }

  alSubir(callback) { this.#alSubir = callback; }

  iniciar() {
    this.#zona.addEventListener("dblclick", () => this.#selector.click());
    this.#zona.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.#selector.click(); }
    });
    this.#selector.addEventListener("change", () => {
      const archivos = this.#selector.files;
      this.#elegirVideo(archivos);
      this.#selector.value = "";
    });

    ["dragenter", "dragover"].forEach((ev) => this.#zona.addEventListener(ev, (e) => { e.preventDefault(); this.#zona.classList.add("over"); }));
    this.#zona.addEventListener("dragleave", (e) => { e.preventDefault(); this.#zona.classList.remove("over"); });
    this.#zona.addEventListener("drop", (e) => {
      e.preventDefault();
      this.#zona.classList.remove("over");
      this.#elegirVideo(e.dataTransfer?.files);
    });
    // Evitar que el navegador abra un archivo soltado fuera del área y salga del panel
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());

    this.#botonCancelar.addEventListener("click", () => this.#cancelar());
    this.#botonDuplicar.addEventListener("click", () => this.#duplicar());
    this.#botonEnviar.addEventListener("click", () => this.#enviar());
  }

  async #elegirVideo(lista) {
    if (this.#enviando || !lista?.length) return;
    const archivo = lista[0];
    PanelFormato.mensaje(this.#resultado, "");
    try {
      await ValidadorVideo.validarVideo(archivo);
    } catch (e) {
      PanelFormato.mensaje(this.#resultado, PanelFormato.errorVisible(e, "No se pudo leer el archivo."), "error");
      return;
    }
    this.#archivo = archivo;
    this.#nombreArchivo.textContent = `${archivo.name} · ${ValidadorVideo.tamano(archivo.size)}`;
    this.#form.llenar({});
    PanelFormato.mensaje(this.#mensaje, lista.length > 1 ? "Se eligió solo el primer video: los videos se suben de uno en uno." : "");
    this.#mostrarProgreso(null);
    this.#inicio.hidden = true;
    this.#seccionForm.hidden = false;
    this.#form.enfocar();
  }

  async #duplicar() {
    if (this.#enviando) return;
    this.#botonDuplicar.disabled = true;
    try {
      const videos = await this.#repo.listar();
      const elegido = await this.#dialogos.elegirVideo(videos);
      if (elegido) {
        // Copia todos los campos menos el archivo de video; las imágenes conservan su ruta.
        const { id, ruta_archivo, creado_en, ...datos } = elegido;
        this.#form.llenar(datos);
        PanelFormato.mensaje(this.#mensaje, `Datos copiados de «${elegido.titulo}». Cambia solo lo necesario.`, "info");
      }
    } catch (e) {
      PanelFormato.mensaje(this.#mensaje, PanelFormato.errorVisible(e, "No se pudo cargar la lista de videos."), "error");
    } finally {
      this.#botonDuplicar.disabled = false;
    }
  }

  async #cancelar() {
    if (this.#enviando) return;
    if (this.#form.haCambiado() && !(await this.#dialogos.confirmar("Hay datos escritos. ¿Descartar este video sin subirlo?", "Descartar"))) return;
    this.#volverAlInicio();
  }

  #volverAlInicio() {
    this.#archivo = null;
    this.#form.llenar({});
    this.#seccionForm.hidden = true;
    this.#inicio.hidden = false;
    this.#mostrarProgreso(null);
    PanelFormato.mensaje(this.#mensaje, "");
  }

  async #enviar() {
    if (this.#enviando || !this.#archivo) return;
    PanelFormato.mensaje(this.#mensaje, "");
    if (!this.#form.validar()) {
      PanelFormato.mensaje(this.#mensaje, "Revisa los campos marcados.", "error");
      return;
    }
    const { textos, imagenes } = this.#form.leer();
    const video = this.#archivo;

    this.#bloquear(true);
    const subidos = [];
    const archivos = [video, imagenes.foto.archivo, imagenes.portada.archivo].filter(Boolean);
    const total = archivos.reduce((s, a) => s + a.size, 0);
    const cargado = new Map();
    const progreso = (archivo, n) => {
      cargado.set(archivo, n);
      const suma = [...cargado.values()].reduce((s, x) => s + x, 0);
      this.#mostrarProgreso(Math.min(99, Math.round((suma / total) * 100)));
    };
    this.#mostrarProgreso(0);

    try {
      const ext = await ValidadorVideo.validarVideo(video);
      const rutaVideo = this.#repo.nuevaRuta("", ext);
      await this.#repo.subirArchivo("videos", rutaVideo, video, (n) => progreso(video, n));
      subidos.push(["videos", rutaVideo]);

      const columnasImagen = await subirImagenesDelFormulario(this.#repo, imagenes, subidos, progreso);
      await this.#repo.crear({ ...textos, ...columnasImagen, ruta_archivo: rutaVideo });

      this.#mostrarProgreso(100);
      this.#volverAlInicio();
      PanelFormato.mensaje(this.#resultado, `Se subió «${textos.titulo}». Ya aparece en "Administrar videos".`, "exito");
      this.#alSubir();
    } catch (e) {
      // Si algo falla, se borran los archivos que sí alcanzaron a subirse.
      for (const [bucket, ruta] of subidos) await this.#repo.borrarArchivos(bucket, [ruta]);
      this.#mostrarProgreso(null);
      PanelFormato.mensaje(this.#mensaje, `No se subió el video. ${PanelFormato.errorVisible(e, "Ocurrió un error inesperado.")}`, "error");
    } finally {
      this.#bloquear(false);
    }
  }

  #bloquear(si) {
    this.#enviando = si;
    this.#form.deshabilitar(si);
    this.#botonEnviar.disabled = si;
    this.#botonCancelar.disabled = si;
    this.#botonDuplicar.disabled = si;
    this.#botonEnviar.textContent = si ? "Subiendo…" : "Subir video";
  }

  #mostrarProgreso(porcentaje) {
    this.#progreso.hidden = porcentaje === null;
    if (porcentaje === null) return;
    this.#progreso.querySelector("progress").value = porcentaje;
    this.#progreso.querySelector("[data-porcentaje]").textContent = `${porcentaje}%`;
  }
}

/** Pestaña "Administrar videos": lista, editar y borrar. */
class PestanaAdministrar {
  #repo;
  #dialogos;
  #form;
  #videos = [];
  #editando = null;
  #desactualizada = true;
  #ocupado = false;

  #vistaLista = document.getElementById("admin-lista");
  #vistaEditar = document.getElementById("admin-editar");
  #filas = document.getElementById("admin-filas");
  #conteo = document.getElementById("admin-conteo");
  #vacio = document.getElementById("admin-vacio");
  #mensajeLista = document.getElementById("admin-mensaje");
  #mensajeEditar = document.getElementById("editar-mensaje");
  #botonGuardar = document.getElementById("editar-guardar");
  #botonDeshacer = document.getElementById("editar-deshacer");
  #botonVolver = document.getElementById("editar-volver");
  #botonRecargar = document.getElementById("admin-recargar");
  #video = document.getElementById("editar-video");

  constructor(repo, dialogos) {
    this.#repo = repo;
    this.#dialogos = dialogos;
    this.#form = new FormularioVideo(document.getElementById("editar-campos"), repo, "editar");
    this.#form.alCambiar(() => this.#actualizarBotones());
  }

  iniciar() {
    this.#botonGuardar.addEventListener("click", () => this.#guardar());
    this.#botonDeshacer.addEventListener("click", () => { this.#form.restaurar(); PanelFormato.mensaje(this.#mensajeEditar, ""); });
    this.#botonVolver.addEventListener("click", () => this.#volver());
    this.#botonRecargar.addEventListener("click", () => this.#cargar());
  }

  marcarDesactualizada() { this.#desactualizada = true; }

  async mostrar() {
    if (this.#desactualizada && !this.#editando) await this.#cargar();
  }

  async #cargar() {
    PanelFormato.mensaje(this.#mensajeLista, "Cargando videos…");
    this.#botonRecargar.disabled = true;
    try {
      this.#videos = await this.#repo.listar();
      this.#desactualizada = false;
      PanelFormato.mensaje(this.#mensajeLista, "");
      this.#render();
    } catch (e) {
      PanelFormato.mensaje(this.#mensajeLista, PanelFormato.errorVisible(e, "No se pudo cargar la lista de videos."), "error");
    } finally {
      this.#botonRecargar.disabled = false;
    }
  }

  #render() {
    this.#filas.replaceChildren(...this.#videos.map((v) => this.#fila(v)));
    this.#vacio.hidden = this.#videos.length > 0;
    this.#conteo.textContent = this.#videos.length === 1 ? "1 video" : `${this.#videos.length} videos`;
  }

  #fila(video) {
    const fila = document.getElementById("tpl-fila").content.firstElementChild.cloneNode(true);
    const miniatura = fila.querySelector("[data-miniatura]");
    miniatura.src = `${this.#repo.urlPublica("videos", video.ruta_archivo)}#t=0.5`;
    fila.querySelector("[data-titulo]").textContent = video.titulo;
    fila.querySelector("[data-descripcion]").textContent = video.descripcion ?? "Sin descripción";
    fila.querySelector("[data-usuario]").textContent = video.usuario ? `@${video.usuario}` : "—";
    fila.querySelector("[data-fecha]").textContent = PanelFormato.fecha(video.creado_en);
    const editar = fila.querySelector("[data-editar]");
    const borrar = fila.querySelector("[data-borrar]");
    editar.setAttribute("aria-label", `Editar «${video.titulo}»`);
    borrar.setAttribute("aria-label", `Borrar «${video.titulo}»`);
    editar.addEventListener("click", () => this.#abrirEditor(video));
    borrar.addEventListener("click", () => this.#borrar(video));
    return fila;
  }

  #abrirEditor(video) {
    this.#editando = video;
    this.#form.llenar(video);
    this.#video.src = this.#repo.urlPublica("videos", video.ruta_archivo);
    document.getElementById("editar-ruta").textContent = video.ruta_archivo;
    document.getElementById("editar-fecha").textContent = PanelFormato.fecha(video.creado_en);
    PanelFormato.mensaje(this.#mensajeEditar, "");
    this.#vistaLista.hidden = true;
    this.#vistaEditar.hidden = false;
    this.#form.enfocar();
  }

  async #volver() {
    if (this.#ocupado) return;
    if (this.#form.haCambiado() && !(await this.#dialogos.confirmar("Tienes cambios sin guardar. ¿Salir sin guardarlos?", "Salir sin guardar"))) return;
    this.#editando = null;
    this.#video.pause();
    this.#video.removeAttribute("src");
    this.#video.load();
    this.#vistaEditar.hidden = true;
    this.#vistaLista.hidden = false;
    if (this.#desactualizada) await this.#cargar(); else this.#render();
  }

  async #guardar() {
    if (this.#ocupado || !this.#editando || !this.#form.haCambiado()) return;
    PanelFormato.mensaje(this.#mensajeEditar, "");
    if (!this.#form.validar()) {
      PanelFormato.mensaje(this.#mensajeEditar, "Revisa los campos marcados.", "error");
      return;
    }
    const original = this.#editando;
    const { textos, imagenes } = this.#form.leer();
    this.#ocupado = true;
    this.#form.deshabilitar(true);
    this.#actualizarBotones();
    PanelFormato.mensaje(this.#mensajeEditar, "Guardando…");
    const subidos = [];
    try {
      const columnasImagen = await subirImagenesDelFormulario(this.#repo, imagenes, subidos, () => {});
      const actualizado = await this.#repo.actualizar(original.id, { ...textos, ...columnasImagen });

      // Imágenes reemplazadas o quitadas: se borran solo si ningún otro video las usa.
      let pendientes = 0;
      for (const { columna } of Object.values(FormularioVideo.IMAGENES)) {
        const anterior = original[columna];
        if (anterior && anterior !== actualizado[columna] && !(await this.#repo.imagenEnUso(anterior))) {
          if (!(await this.#repo.borrarArchivos("imagenes", [anterior]))) pendientes++;
        }
      }

      this.#videos = this.#videos.map((v) => (v.id === actualizado.id ? actualizado : v));
      this.#editando = actualizado;
      this.#form.llenar(actualizado);
      PanelFormato.mensaje(this.#mensajeEditar, pendientes
        ? "Cambios guardados, pero una imagen anterior no se pudo borrar de Storage."
        : "Cambios guardados.", pendientes ? "error" : "exito");
    } catch (e) {
      for (const [bucket, ruta] of subidos) await this.#repo.borrarArchivos(bucket, [ruta]);
      PanelFormato.mensaje(this.#mensajeEditar, `No se guardaron los cambios. ${PanelFormato.errorVisible(e, "Ocurrió un error inesperado.")}`, "error");
    } finally {
      this.#ocupado = false;
      this.#form.deshabilitar(false);
      this.#actualizarBotones();
    }
  }

  async #borrar(video) {
    if (this.#ocupado) return;
    const ok = await this.#dialogos.confirmar(
      `¿Borrar «${video.titulo}»? Se eliminan el registro y su video. Las imágenes se borran solo si ningún otro video las usa. No se puede deshacer.`,
      "Borrar video",
    );
    if (!ok) return;
    this.#ocupado = true;
    PanelFormato.mensaje(this.#mensajeLista, "Borrando…");
    try {
      const pendientes = await this.#repo.borrarVideo(video);
      this.#videos = this.#videos.filter((v) => v.id !== video.id);
      this.#render();
      PanelFormato.mensaje(this.#mensajeLista, pendientes
        ? `Se borró «${video.titulo}», pero ${pendientes} archivo(s) no se pudieron eliminar de Storage.`
        : `Se borró «${video.titulo}».`, pendientes ? "error" : "exito");
    } catch (e) {
      PanelFormato.mensaje(this.#mensajeLista, PanelFormato.errorVisible(e, "No se pudo borrar el video."), "error");
    } finally {
      this.#ocupado = false;
    }
  }

  #actualizarBotones() {
    const cambios = this.#form.haCambiado();
    this.#botonGuardar.disabled = this.#ocupado || !cambios;
    this.#botonDeshacer.disabled = this.#ocupado || !cambios;
  }
}
