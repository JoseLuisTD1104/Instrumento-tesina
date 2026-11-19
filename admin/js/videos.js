"use strict";

/** Error con un mensaje que se puede mostrar al administrador (sin datos internos). */
class ErrorPanel extends Error {}

/** Reglas de los datos de un video. Reflejan las restricciones de la tabla public.videos. */
class ValidadorVideo {
  static LIMITES = Object.freeze({
    titulo: [1, 150],
    descripcion: [0, 2200],
    usuario: [0, 30],
    sonido_nombre: [0, 100],
    sonido_autor: [0, 100],
  });
  static NOMBRES = Object.freeze({
    titulo: "El título",
    descripcion: "La descripción",
    usuario: "El @usuario",
    sonido_nombre: "El nombre del sonido",
    sonido_autor: "El autor del sonido",
  });
  static PATRON_USUARIO = /^[A-Za-z0-9._]+$/;

  // Igual a los límites configurados en los buckets de Supabase.
  static MAX_VIDEO_BYTES = 50 * 1024 * 1024;   // bucket "videos"
  static MAX_IMAGEN_BYTES = 10 * 1024 * 1024;  // bucket "imagenes"

  static TIPOS_VIDEO = Object.freeze({ "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" });
  static TIPOS_IMAGEN = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });

  /** Largo como lo cuenta PostgreSQL (caracteres, no unidades UTF-16). */
  static largo(texto) {
    return [...texto].length;
  }

  /** Limpia los textos del formulario. Los opcionales vacíos se guardan como null. */
  static normalizar(datos) {
    const limpio = (v) => String(v ?? "").replace(/\u0000/g, "").trim();
    const opcional = (v) => (limpio(v) === "" ? null : limpio(v));
    return {
      titulo: limpio(datos.titulo),
      descripcion: opcional(datos.descripcion),
      usuario: opcional(String(datos.usuario ?? "").trim().replace(/^@+/, "")),
      sonido_nombre: opcional(datos.sonido_nombre),
      sonido_autor: opcional(datos.sonido_autor),
    };
  }

  /** Devuelve { campo: mensaje } con los errores encontrados (vacío si todo está bien). */
  static validarTextos(textos) {
    const errores = {};
    for (const [campo, [min, max]] of Object.entries(ValidadorVideo.LIMITES)) {
      const n = ValidadorVideo.largo(textos[campo] ?? "");
      if (n < min) errores[campo] = `${ValidadorVideo.NOMBRES[campo]} es obligatorio.`;
      else if (n > max) errores[campo] = `${ValidadorVideo.NOMBRES[campo]} no puede pasar de ${max} caracteres (tiene ${n}).`;
    }
    if (textos.usuario && !errores.usuario && !ValidadorVideo.PATRON_USUARIO.test(textos.usuario)) {
      errores.usuario = "El @usuario solo puede tener letras sin acentos, números, punto y guion bajo.";
    }
    return errores;
  }

  /** Comprueba tipo, tamaño y firma del archivo. Devuelve la extensión segura para guardarlo. */
  static async validarVideo(archivo) {
    const ext = ValidadorVideo.TIPOS_VIDEO[archivo?.type];
    if (!ext) throw new ErrorPanel("El archivo no es un video MP4, WebM o MOV.");
    if (archivo.size === 0) throw new ErrorPanel("El archivo de video está vacío.");
    if (archivo.size > ValidadorVideo.MAX_VIDEO_BYTES) {
      throw new ErrorPanel(`El video pesa ${ValidadorVideo.tamano(archivo.size)}; el máximo es ${ValidadorVideo.tamano(ValidadorVideo.MAX_VIDEO_BYTES)}.`);
    }
    const b = await ValidadorVideo.#bytes(archivo, 12);
    const esMp4oMov = b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70; // "ftyp"
    const esWebm = b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
    if ((ext === "webm" && !esWebm) || (ext !== "webm" && !esMp4oMov)) {
      throw new ErrorPanel("El contenido del archivo no corresponde a un video válido.");
    }
    return ext;
  }

  static async validarImagen(archivo) {
    const ext = ValidadorVideo.TIPOS_IMAGEN[archivo?.type];
    if (!ext) throw new ErrorPanel("La imagen debe ser PNG, JPEG o WebP.");
    if (archivo.size === 0) throw new ErrorPanel("La imagen está vacía.");
    if (archivo.size > ValidadorVideo.MAX_IMAGEN_BYTES) {
      throw new ErrorPanel(`La imagen pesa ${ValidadorVideo.tamano(archivo.size)}; el máximo es ${ValidadorVideo.tamano(ValidadorVideo.MAX_IMAGEN_BYTES)}.`);
    }
    const b = await ValidadorVideo.#bytes(archivo, 12);
    const firmas = {
      png: b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
      jpg: b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
      webp: b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
            b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
    };
    if (!firmas[ext]) throw new ErrorPanel("El contenido de la imagen no corresponde a su tipo.");
    return ext;
  }

  static tamano(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  static async #bytes(archivo, n) {
    return new Uint8Array(await archivo.slice(0, n).arrayBuffer());
  }
}

/** Acceso a la tabla public.videos y a los buckets "videos" e "imagenes". */
class VideoRepositorio {
  static COLUMNAS = "id,titulo,descripcion,ruta_archivo,creado_en,usuario,foto_perfil_ruta,sonido_nombre,sonido_autor,portada_sonido_ruta,publicado,publicado_en,me_gusta_num,comentarios_num,guardados_num";
  static SEGUNDOS_FIRMA = 600; // 10 minutos: miniaturas y vista previa del panel
  static RUTA_IMAGEN = /^(perfiles|portadas)\/[0-9a-f-]{36}\.(png|jpg|webp)$/;

  #sb;
  #origen;
  #clave;

  constructor(cliente, config) {
    this.#sb = cliente;
    this.#origen = new URL(config.SUPABASE_URL).origin;
    this.#clave = config.SUPABASE_PUBLISHABLE_KEY;
  }

  async listar() {
    const { data, error } = await this.#sb.from("videos")
      .select(VideoRepositorio.COLUMNAS).order("creado_en", { ascending: false });
    if (error) throw this.#traducir(error, "No se pudo cargar la lista de videos.");
    return data ?? [];
  }

  async crear(fila) {
    // Todo video nuevo nace sin publicar: solo aparece en el feed al pulsar Publicar.
    const { data, error } = await this.#sb.from("videos").insert({ ...fila, publicado: false })
      .select(VideoRepositorio.COLUMNAS).single();
    if (error) throw this.#traducir(error, "No se pudo guardar el video en la base de datos.");
    return data;
  }

  async actualizar(id, cambios) {
    const { data, error } = await this.#sb.from("videos").update(cambios).eq("id", id)
      .select(VideoRepositorio.COLUMNAS).single();
    if (error) throw this.#traducir(error, "No se pudieron guardar los cambios.");
    return data;
  }

  /** Publica el video: entra al final de la cola del feed (ordenada por publicado_en). */
  async publicar(id) {
    return this.#cambiarPublicacion(id, { publicado: true, publicado_en: new Date().toISOString() },
      "No se pudo publicar el video.");
  }

  async quitarDelFeed(id) {
    return this.#cambiarPublicacion(id, { publicado: false }, "No se pudo quitar el video del feed.");
  }

  async #cambiarPublicacion(id, cambios, generico) {
    const { data, error } = await this.#sb.from("videos").update(cambios).eq("id", id)
      .select(VideoRepositorio.COLUMNAS).single();
    if (error) throw this.#traducir(error, generico);
    return data;
  }

  /** Borra el registro y luego sus archivos. Devuelve cuántos archivos no se pudieron borrar. */
  async borrarVideo(video) {
    const { data, error } = await this.#sb.from("videos").delete().eq("id", video.id).select("id");
    if (error) throw this.#traducir(error, "No se pudo borrar el video.");
    if (!data?.length) throw new ErrorPanel("No se pudo borrar el video: no existe o no tienes permiso.");

    let pendientes = 0;
    if (!(await this.borrarArchivos("videos", [video.ruta_archivo]))) pendientes++;
    for (const ruta of new Set([video.foto_perfil_ruta, video.portada_sonido_ruta])) {
      if (ruta && !(await this.imagenEnUso(ruta))) {
        if (!(await this.borrarArchivos("imagenes", [ruta]))) pendientes++;
      }
    }
    return pendientes;
  }

  /** true si algún video (de cualquier columna de imagen) todavía usa esa ruta. */
  async imagenEnUso(ruta) {
    // Una ruta que no generó este panel nunca se borra (y no se mete en el filtro).
    if (!VideoRepositorio.RUTA_IMAGEN.test(ruta)) return true;
    for (const columna of ["foto_perfil_ruta", "portada_sonido_ruta"]) {
      const { data, error } = await this.#sb.from("videos").select("id").eq(columna, ruta).limit(1);
      if (error || data.length > 0) return true; // ante la duda, no se borra
    }
    return false;
  }

  /** true si se borraron. */
  async borrarArchivos(bucket, rutas) {
    const validas = rutas.filter(Boolean);
    if (!validas.length) return true;
    try {
      const { error } = await this.#sb.storage.from(bucket).remove(validas);
      return !error;
    } catch {
      return false;
    }
  }

  /** Solo para el bucket público "imagenes". */
  urlImagen(ruta) {
    if (!ruta) return null;
    return this.#sb.storage.from("imagenes").getPublicUrl(ruta).data.publicUrl;
  }

  /** Bucket privado "videos": URL firmada de corta duración con la sesión del administrador. */
  async urlVideo(ruta) {
    const { data, error } = await this.#sb.storage.from("videos").createSignedUrl(ruta, VideoRepositorio.SEGUNDOS_FIRMA);
    if (error || !data?.signedUrl) throw new ErrorPanel("No se pudo obtener la vista previa del video.");
    return data.signedUrl;
  }

  /** Varias URLs firmadas en una sola petición. Devuelve Map(ruta -> url). */
  async urlsVideos(rutas) {
    const unicas = [...new Set(rutas.filter(Boolean))];
    if (!unicas.length) return new Map();
    const { data, error } = await this.#sb.storage.from("videos").createSignedUrls(unicas, VideoRepositorio.SEGUNDOS_FIRMA);
    if (error || !Array.isArray(data)) return new Map();
    return new Map(data.filter((d) => d.signedUrl && !d.error).map((d) => [d.path, d.signedUrl]));
  }

  nuevaRuta(carpeta, ext) {
    return `${carpeta ? `${carpeta}/` : ""}${crypto.randomUUID()}.${ext}`;
  }

  /** Sube con XMLHttpRequest para poder informar el progreso (supabase-js no lo da). */
  async subirArchivo(bucket, ruta, archivo, alProgreso = () => {}) {
    const { data } = await this.#sb.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) throw new ErrorPanel("Tu sesión terminó. Vuelve a iniciar sesión.");

    const destino = `${this.#origen}/storage/v1/object/${encodeURIComponent(bucket)}/${ruta.split("/").map(encodeURIComponent).join("/")}`;
    await new Promise((resolver, rechazar) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", destino);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("apikey", this.#clave);
      xhr.setRequestHeader("x-upsert", "false");
      xhr.setRequestHeader("cache-control", "3600");
      xhr.setRequestHeader("Content-Type", archivo.type);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) alProgreso(e.loaded); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) { alProgreso(archivo.size); resolver(); return; }
        rechazar(this.#errorStorage(xhr.status));
      };
      xhr.onerror = () => rechazar(new ErrorPanel("No hay conexión con Supabase. Revisa tu internet e intenta de nuevo."));
      xhr.ontimeout = xhr.onerror;
      xhr.send(archivo);
    });
  }

  #errorStorage(estado) {
    if (estado === 401 || estado === 403) return new ErrorPanel("Storage rechazó el archivo: tu sesión no tiene permiso o terminó.");
    if (estado === 413) return new ErrorPanel("El archivo supera el tamaño que permite el bucket de Storage.");
    if (estado === 409) return new ErrorPanel("Ya existe un archivo con ese nombre en Storage. Intenta de nuevo.");
    if (estado === 400 || estado === 415) return new ErrorPanel("Storage rechazó el tipo de archivo.");
    return new ErrorPanel("No se pudo subir el archivo a Storage. Intenta de nuevo.");
  }

  #traducir(error, generico) {
    const codigo = error?.code;
    if (codigo === "42501" || codigo === "PGRST301" || error?.status === 401 || error?.status === 403) {
      return new ErrorPanel("La base de datos rechazó la operación: tu sesión no tiene permiso o terminó.");
    }
    if (codigo === "23514" || codigo === "22001" || codigo === "23502") {
      return new ErrorPanel("Algún dato no cumple las reglas de la base de datos (campo obligatorio o largo).");
    }
    if (codigo === "PGRST116") return new ErrorPanel(`${generico} El video no existe o no tienes permiso.`);
    return new ErrorPanel(generico);
  }
}
