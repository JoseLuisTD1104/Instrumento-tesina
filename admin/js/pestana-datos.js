"use strict";

/**
 * Pestaña "Datos": los datos de la prueba para revisarlos y exportarlos. Cada subsección es una clase con
 * mostrar(); hoy solo existe "Interacciones" (clics y visualización del feed). Para agregar otra (p. ej., la
 * encuesta de deepfakes) basta con su sección en panel.html (data-subseccion-datos) y registrarla en
 * PestanaDatos. Todo se lee con la Edge Function "admin-datos" (solo administrador): el panel nunca lee las
 * tablas directo. Todo texto se pinta con textContent; nunca innerHTML.
 */

/** Llamadas a "admin-datos" con mensajes claros para el administrador (sin datos internos). */
class ClienteDatos {
  static FUNCION = "admin-datos";
  static MENSAJES = Object.freeze({
    demasiadas_filas: "Son demasiadas filas para una sola descarga. Aplica un filtro y descarga por partes.",
  });

  #cliente;

  constructor(clienteSupabase) {
    this.#cliente = clienteSupabase;
  }

  async #invocar(accion, datos = {}) {
    let respuesta;
    try {
      respuesta = await this.#cliente.functions.invoke(ClienteDatos.FUNCION, { body: { accion, ...datos } });
    } catch {
      throw new ErrorPanel("No hay conexión con el servidor.");
    }
    const { data, error } = respuesta;
    if (error) {
      if (error.context?.status === 401) throw new ErrorPanel("El servidor no reconoce tu sesión de administrador. Vuelve a iniciar sesión.");
      const cuerpo = await error.context?.json?.().catch(() => null);
      throw new ErrorPanel(ClienteDatos.MENSAJES[cuerpo?.error] ?? "El servidor no pudo leer los datos.");
    }
    return data;
  }

  /** { participantes: [codigo], videos: [numero_video] } para los filtros. */
  async opciones() {
    const datos = await this.#invocar("opciones");
    if (!Array.isArray(datos?.participantes) || !Array.isArray(datos?.videos)) throw new ErrorPanel("No se pudieron leer los filtros.");
    return datos;
  }

  /** { filas, total } de una página. */
  async pagina(consulta, pagina, tamano) {
    return ClienteDatos.#resultado(await this.#invocar("pagina", { ...consulta, pagina, tamano }));
  }

  /** { filas, total } con todas las filas de la consulta (el servidor las lee por lotes). */
  async exportar(consulta) {
    return ClienteDatos.#resultado(await this.#invocar("exportar", consulta));
  }

  static #resultado(datos) {
    if (!Array.isArray(datos?.filas) || !Number.isInteger(datos?.total)) throw new ErrorPanel("La respuesta del servidor no es válida.");
    return datos;
  }
}

/**
 * Definición de una vista de datos: columnas (clave, encabezado en español y tipo para el Excel) y su filtro
 * propio (tipo o fase). Las claves son las que devuelve "admin-datos".
 */
class VistaDeDatos {
  static CLICS = new VistaDeDatos("clics", "Clics", "interacciones-clics", [
    ["codigo_participante", "Participante", "texto"],
    ["numero_video", "N.º de video", "numero"],
    ["tipo", "Tipo", "texto"],
    ["detalle", "Detalle", "texto"],
    ["tiempo_video_ms", "Tiempo del video (ms)", "numero"],
    ["duracion_ms", "Duración (ms)", "numero"],
    ["creado_en", "Fecha y hora", "texto"],
  ], {
    clave: "tipo", etiqueta: "Tipo", valores: [
      "me_gusta", "quitar_me_gusta", "guardar", "quitar_guardar", "comentarios", "compartir", "compartir_cerrado",
      "ver_enlace", "ver_enlace_cerrado", "mas_opciones", "seguir", "dejar_seguir", "pausa", "reanudar", "silenciar",
      "activar_sonido",
    ],
  });

  static VISUALIZACION = new VistaDeDatos("visualizacion", "Visualización", "interacciones-visualizacion", [
    ["codigo_participante", "Participante", "texto"],
    ["numero_video", "N.º de video", "numero"],
    ["fase", "Fase", "texto"],
    ["posicion", "Posición", "numero"],
    ["tiempo_pantalla_ms", "Tiempo en pantalla (ms)", "numero"],
    ["reproduccion_ms", "Reproducción (ms)", "numero"],
    ["completo", "Completo", "booleano"],
    ["creado_en", "Fecha y hora", "texto"],
  ], { clave: "fase", etiqueta: "Fase", valores: ["ciega", "evaluacion"] });

  constructor(id, nombre, archivo, columnas, filtro) {
    this.id = id;
    this.nombre = nombre;
    this.archivo = archivo;
    this.columnas = Object.freeze(columnas.map(([clave, encabezado, tipo]) => Object.freeze({ clave, encabezado, tipo })));
    this.filtro = Object.freeze(filtro);
    Object.freeze(this);
  }

  /** El valor tal como está guardado, como texto para la tabla y el CSV (null → vacío). */
  static texto(valor) {
    return valor === null || valor === undefined ? "" : String(valor);
  }
}

/** Tabla ordenable: encabezados con botón (aria-sort) y filas pintadas con textContent. */
class TablaDeDatos {
  #tabla;
  #cabecera;
  #cuerpo;
  #alOrdenar;
  #vista = null;

  constructor(tabla, alOrdenar) {
    this.#tabla = tabla;
    this.#cabecera = tabla.querySelector("thead");
    this.#cuerpo = tabla.querySelector("tbody");
    this.#alOrdenar = alOrdenar;
  }

  /** Encabezados de la vista con el orden actual marcado. */
  encabezados(vista, orden) {
    this.#vista = vista;
    const fila = document.createElement("tr");
    for (const col of vista.columnas) {
      const th = document.createElement("th");
      th.scope = "col";
      th.dataset.tipo = col.tipo;
      const activa = orden.columna === col.clave;
      th.setAttribute("aria-sort", activa ? (orden.direccion === "asc" ? "ascending" : "descending") : "none");
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "orden-columna";
      const texto = document.createElement("span");
      texto.textContent = col.encabezado;
      const flecha = document.createElement("span");
      flecha.className = "orden-flecha";
      flecha.setAttribute("aria-hidden", "true");
      flecha.textContent = activa ? (orden.direccion === "asc" ? "▲" : "▼") : "↕";
      boton.append(texto, flecha);
      boton.setAttribute("aria-label", `Ordenar por ${col.encabezado}`);
      boton.addEventListener("click", () => this.#alOrdenar(col.clave));
      th.append(boton);
      fila.append(th);
    }
    this.#cabecera.replaceChildren(fila);
  }

  filas(filas) {
    this.#cuerpo.replaceChildren(...filas.map((f) => {
      const tr = document.createElement("tr");
      for (const col of this.#vista.columnas) {
        const td = document.createElement("td");
        td.dataset.tipo = col.tipo;
        td.textContent = VistaDeDatos.texto(f[col.clave]);
        tr.append(td);
      }
      return tr;
    }));
  }

  ocupada(si) {
    this.#tabla.setAttribute("aria-busy", String(si));
  }
}

/** Carga un script del propio panel solo cuando se necesita (la librería del Excel pesa ~1 MB). */
class CargadorDeScript {
  static #cargas = new Map();

  static cargar(ruta) {
    if (!CargadorDeScript.#cargas.has(ruta)) {
      CargadorDeScript.#cargas.set(ruta, new Promise((resolver, rechazar) => {
        const script = document.createElement("script");
        script.src = ruta;
        script.onload = resolver;
        script.onerror = () => {
          CargadorDeScript.#cargas.delete(ruta);
          script.remove();
          rechazar(new ErrorPanel("No se pudo cargar el generador de Excel. Recarga la página."));
        };
        document.head.append(script);
      }));
    }
    return CargadorDeScript.#cargas.get(ruta);
  }
}

/**
 * Archivos de descarga con las mismas columnas que la vista. CSV: UTF-8 con BOM, separado por comas y con
 * comillas cuando hace falta (RFC 4180). Excel: ExcelJS (admin/vendor), con números y verdadero/falso como
 * tales y el resto como texto, tal como está guardado.
 */
class ExportadorDeDatos {
  static RUTA_EXCELJS = "vendor/exceljs-4.4.0.min.js";
  static BOM = "﻿";

  static nombre(vista, extension) {
    const hoy = new Date();
    const fecha = [hoy.getFullYear(), hoy.getMonth() + 1, hoy.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
    return `${vista.archivo}-${fecha}.${extension}`;
  }

  static csv(vista, filas) {
    const celda = (texto) => (/[",\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto);
    const lineas = [vista.columnas.map((c) => celda(c.encabezado)).join(",")];
    for (const f of filas) lineas.push(vista.columnas.map((c) => celda(VistaDeDatos.texto(f[c.clave]))).join(","));
    return new Blob([ExportadorDeDatos.BOM + lineas.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  }

  static async xlsx(vista, filas) {
    await CargadorDeScript.cargar(ExportadorDeDatos.RUTA_EXCELJS);
    const ExcelJS = window.ExcelJS;
    if (!ExcelJS?.Workbook) throw new ErrorPanel("No se pudo cargar el generador de Excel. Recarga la página.");
    const libro = new ExcelJS.Workbook();
    libro.creator = "corto";
    const hoja = libro.addWorksheet(vista.nombre, { views: [{ state: "frozen", ySplit: 1 }] });
    hoja.columns = vista.columnas.map((c) => ({ header: c.encabezado, key: c.clave, width: Math.max(14, c.encabezado.length + 4) }));
    hoja.getRow(1).font = { bold: true };
    for (const f of filas) {
      hoja.addRow(Object.fromEntries(vista.columnas.map((c) => [c.clave, ExportadorDeDatos.#valorExcel(f[c.clave], c.tipo)])));
    }
    const bytes = await libro.xlsx.writeBuffer();
    return new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  static #valorExcel(valor, tipo) {
    if (valor === null || valor === undefined) return null;
    if (tipo === "numero" && typeof valor === "number") return valor;
    if (tipo === "booleano" && typeof valor === "boolean") return valor;
    return String(valor);
  }

  static descargar(blob, nombre) {
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement("a");
    enlace.href = url;
    enlace.download = nombre;
    document.body.append(enlace);
    enlace.click();
    enlace.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
}

/** Botón de descarga (solo ícono) con un menú pequeño "CSV / Excel". Esc o un clic fuera lo cierran. */
class MenuDeDescarga {
  #boton;
  #menu;
  #opciones;
  #alElegir;

  constructor(boton, menu, alElegir) {
    this.#boton = boton;
    this.#menu = menu;
    this.#opciones = [...menu.querySelectorAll('[role="menuitem"]')];
    this.#alElegir = alElegir;
    boton.addEventListener("click", () => (this.#menu.hidden ? this.#abrir() : this.cerrar()));
    for (const opcion of this.#opciones) {
      opcion.addEventListener("click", () => {
        this.cerrar(true);
        this.#alElegir(opcion.dataset.formato);
      });
    }
    menu.addEventListener("keydown", (e) => this.#tecla(e));
    document.addEventListener("click", (e) => {
      if (!this.#menu.hidden && !this.#menu.contains(e.target) && !this.#boton.contains(e.target)) this.cerrar();
    });
  }

  habilitar(si) {
    this.#boton.disabled = !si;
    if (!si) this.cerrar();
  }

  cerrar(enfocar = false) {
    this.#menu.hidden = true;
    this.#boton.setAttribute("aria-expanded", "false");
    if (enfocar) this.#boton.focus();
  }

  #abrir() {
    this.#menu.hidden = false;
    this.#boton.setAttribute("aria-expanded", "true");
    this.#opciones[0].focus();
  }

  #tecla(e) {
    const i = this.#opciones.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); this.cerrar(true); return; }
    if (e.key === "Tab") { this.cerrar(); return; }
    const j = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: this.#opciones.length - 1 }[e.key];
    if (j === undefined) return;
    e.preventDefault();
    this.#opciones[(j + this.#opciones.length) % this.#opciones.length].focus();
  }
}

/**
 * Subsección "Interacciones": dos vistas con selector ("Clics" y "Visualización"); en cada una, ordenar por
 * columna, filtrar por participante, video y tipo (o fase), y paginar. Cada vista recuerda sus filtros, su
 * orden y su página mientras el panel está abierto (solo en memoria). La descarga baja la vista activa con
 * los filtros y el orden que tenga.
 */
class SubseccionInteracciones {
  static TAMANOS = [25, 50, 100];
  static ORDEN_INICIAL = Object.freeze({ columna: "creado_en", direccion: "asc" });

  #cliente;
  #raiz;
  #vistas = [VistaDeDatos.CLICS, VistaDeDatos.VISUALIZACION];
  #estados = new Map(); // id de vista → { filtros, orden, pagina, tamano }
  #vista = VistaDeDatos.CLICS;
  #tabla;
  #menu;
  #opcionesCargadas = false;
  #turno = 0;
  #exportando = false;
  #total = 0;

  #pestanasVista;
  #filtroParticipante;
  #filtroVideo;
  #filtroExtra;
  #etiquetaExtra;
  #tamano;
  #mensaje;
  #resumen;
  #anterior;
  #siguiente;
  #paginaTexto;
  #limpiar;

  constructor(cliente, raiz) {
    this.#cliente = cliente;
    this.#raiz = raiz;
    const $ = (sel) => raiz.querySelector(sel);
    this.#pestanasVista = [...raiz.querySelectorAll("[data-vista-datos]")];
    this.#filtroParticipante = $("[data-filtro-participante]");
    this.#filtroVideo = $("[data-filtro-video]");
    this.#filtroExtra = $("[data-filtro-extra]");
    this.#etiquetaExtra = $("[data-etiqueta-extra]");
    this.#tamano = $("[data-tamano]");
    this.#mensaje = $("[data-mensaje-datos]");
    this.#resumen = $("[data-resumen]");
    this.#anterior = $("[data-pagina-anterior]");
    this.#siguiente = $("[data-pagina-siguiente]");
    this.#paginaTexto = $("[data-pagina-texto]");
    this.#limpiar = $("[data-limpiar-filtros]");
    this.#tabla = new TablaDeDatos($("[data-tabla-datos]"), (columna) => this.#ordenar(columna));
    this.#menu = new MenuDeDescarga($("[data-descargar]"), $("[data-menu-descarga]"), (formato) => this.#exportar(formato));
    for (const v of this.#vistas) {
      this.#estados.set(v.id, { filtros: { participante: null, video: null, extra: null }, orden: { ...SubseccionInteracciones.ORDEN_INICIAL }, pagina: 1, tamano: 25 });
    }
    this.#tamano.replaceChildren(...SubseccionInteracciones.TAMANOS.map((n) => new Option(`${n} por página`, String(n))));
  }

  iniciar() {
    this.#pestanasVista.forEach((boton, i) => {
      boton.addEventListener("click", () => this.#elegirVista(i));
      boton.addEventListener("keydown", (e) => {
        const n = this.#pestanasVista.length;
        const j = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n }[e.key];
        if (j === undefined) return;
        e.preventDefault();
        this.#elegirVista(j);
        this.#pestanasVista[j].focus();
      });
    });
    const alFiltrar = () => {
      const estado = this.#estado();
      estado.filtros = {
        participante: this.#filtroParticipante.value || null,
        video: this.#filtroVideo.value ? Number(this.#filtroVideo.value) : null,
        extra: this.#filtroExtra.value || null,
      };
      estado.pagina = 1;
      this.#cargar();
    };
    for (const s of [this.#filtroParticipante, this.#filtroVideo, this.#filtroExtra]) s.addEventListener("change", alFiltrar);
    this.#limpiar.addEventListener("click", () => {
      this.#filtroParticipante.value = "";
      this.#filtroVideo.value = "";
      this.#filtroExtra.value = "";
      alFiltrar();
    });
    this.#tamano.addEventListener("change", () => {
      const estado = this.#estado();
      estado.tamano = Number(this.#tamano.value);
      estado.pagina = 1;
      this.#cargar();
    });
    this.#anterior.addEventListener("click", () => this.#irA(this.#estado().pagina - 1));
    this.#siguiente.addEventListener("click", () => this.#irA(this.#estado().pagina + 1));
  }

  /** Al entrar a la subsección: carga los filtros (una vez) y la vista activa con datos frescos. */
  async mostrar() {
    if (!this.#opcionesCargadas) {
      try {
        const { participantes, videos } = await this.#cliente.opciones();
        SubseccionInteracciones.#llenar(this.#filtroParticipante, "Todos", participantes.map((c) => [c, c]));
        SubseccionInteracciones.#llenar(this.#filtroVideo, "Todos", videos.map((n) => [String(n), `N.º ${n}`]));
        this.#opcionesCargadas = true;
      } catch (e) {
        PanelFormato.mensaje(this.#mensaje, `No se cargaron los filtros. ${PanelFormato.errorVisible(e, "Intenta de nuevo.")}`, "error");
      }
    }
    this.#pintarVista();
    await this.#cargar();
  }

  #estado() { return this.#estados.get(this.#vista.id); }

  #consulta() {
    const { filtros, orden } = this.#estado();
    const f = {};
    if (filtros.participante) f.participante = filtros.participante;
    if (filtros.video !== null) f.video = filtros.video;
    if (filtros.extra) f[this.#vista.filtro.clave] = filtros.extra;
    return { vista: this.#vista.id, filtros: f, orden: { ...orden } };
  }

  #elegirVista(i) {
    const vista = this.#vistas[i];
    if (vista === this.#vista) return;
    this.#vista = vista;
    this.#pintarVista();
    this.#cargar();
  }

  /** Selector de vista, filtros y encabezados según la vista activa y lo que tenía guardado. */
  #pintarVista() {
    this.#pestanasVista.forEach((boton, i) => {
      const activa = this.#vistas[i] === this.#vista;
      boton.setAttribute("aria-selected", String(activa));
      boton.tabIndex = activa ? 0 : -1;
    });
    const { filtros, orden, tamano } = this.#estado();
    this.#etiquetaExtra.textContent = this.#vista.filtro.etiqueta;
    this.#filtroExtra.setAttribute("aria-label", `Filtrar por ${this.#vista.filtro.etiqueta.toLowerCase()}`);
    SubseccionInteracciones.#llenar(this.#filtroExtra, "Todos", this.#vista.filtro.valores.map((v) => [v, v]));
    this.#filtroParticipante.value = filtros.participante ?? "";
    this.#filtroVideo.value = filtros.video === null ? "" : String(filtros.video);
    this.#filtroExtra.value = filtros.extra ?? "";
    this.#tamano.value = String(tamano);
    this.#tabla.encabezados(this.#vista, orden);
  }

  #ordenar(columna) {
    const estado = this.#estado();
    estado.orden = estado.orden.columna === columna
      ? { columna, direccion: estado.orden.direccion === "asc" ? "desc" : "asc" }
      : { columna, direccion: "asc" };
    estado.pagina = 1;
    this.#tabla.encabezados(this.#vista, estado.orden);
    this.#cargar();
  }

  #irA(pagina) {
    const estado = this.#estado();
    const paginas = Math.max(1, Math.ceil(this.#total / estado.tamano));
    if (pagina < 1 || pagina > paginas) return;
    estado.pagina = pagina;
    this.#cargar();
  }

  /** Pide la página actual. Si mientras tanto se pidió otra, la respuesta vieja se descarta. */
  async #cargar() {
    const turno = ++this.#turno;
    const vista = this.#vista;
    const estado = this.#estado();
    this.#tabla.ocupada(true);
    this.#anterior.disabled = true;
    this.#siguiente.disabled = true;
    PanelFormato.mensaje(this.#mensaje, "");
    try {
      const { filas, total } = await this.#cliente.pagina(this.#consulta(), estado.pagina, estado.tamano);
      if (turno !== this.#turno) return;
      const paginas = Math.max(1, Math.ceil(total / estado.tamano));
      if (estado.pagina > paginas) { estado.pagina = paginas; this.#cargar(); return; } // cambiaron los datos
      this.#total = total;
      this.#tabla.filas(filas);
      this.#pintarPaginacion(vista, estado, total, filas.length);
    } catch (e) {
      if (turno !== this.#turno) return;
      this.#total = 0;
      this.#tabla.filas([]);
      this.#pintarPaginacion(vista, estado, 0, 0);
      PanelFormato.mensaje(this.#mensaje, PanelFormato.errorVisible(e, "No se pudieron cargar los datos."), "error");
    } finally {
      if (turno === this.#turno) this.#tabla.ocupada(false);
    }
  }

  #pintarPaginacion(vista, estado, total, enPagina) {
    const paginas = Math.max(1, Math.ceil(total / estado.tamano));
    const desde = total ? (estado.pagina - 1) * estado.tamano + 1 : 0;
    const formato = new Intl.NumberFormat("es-MX");
    this.#resumen.textContent = total
      ? `${vista.nombre}: ${formato.format(desde)}–${formato.format(desde + enPagina - 1)} de ${formato.format(total)} filas`
      : `${vista.nombre}: sin filas con estos filtros`;
    this.#paginaTexto.textContent = `Página ${formato.format(estado.pagina)} de ${formato.format(paginas)}`;
    this.#anterior.disabled = estado.pagina <= 1;
    this.#siguiente.disabled = estado.pagina >= paginas;
    this.#menu.habilitar(total > 0 && !this.#exportando);
  }

  async #exportar(formato) {
    if (this.#exportando) return;
    this.#exportando = true;
    this.#menu.habilitar(false);
    const vista = this.#vista;
    PanelFormato.mensaje(this.#mensaje, "Preparando la descarga…");
    try {
      const { filas } = await this.#cliente.exportar(this.#consulta());
      const blob = formato === "xlsx" ? await ExportadorDeDatos.xlsx(vista, filas) : ExportadorDeDatos.csv(vista, filas);
      ExportadorDeDatos.descargar(blob, ExportadorDeDatos.nombre(vista, formato));
      PanelFormato.mensaje(this.#mensaje, `Se descargaron ${new Intl.NumberFormat("es-MX").format(filas.length)} filas.`, "exito");
    } catch (e) {
      PanelFormato.mensaje(this.#mensaje, PanelFormato.errorVisible(e, "No se pudo preparar la descarga."), "error");
    } finally {
      this.#exportando = false;
      this.#menu.habilitar(this.#total > 0);
    }
  }

  static #llenar(selector, todos, opciones) {
    const previo = selector.value;
    selector.replaceChildren(new Option(todos, ""), ...opciones.map(([valor, texto]) => new Option(texto, valor)));
    selector.value = opciones.some(([v]) => v === previo) ? previo : "";
  }
}

/** Pestaña "Datos": navegación entre subsecciones (role="tablist") y carga de la activa al mostrarse. */
class PestanaDatos {
  #subsecciones = new Map(); // id → { boton, panel, controlador }
  #activa = null;

  /** subsecciones: { id: controlador con iniciar() y mostrar() }, con su botón y panel en panel.html. */
  constructor(subsecciones) {
    for (const [id, controlador] of Object.entries(subsecciones)) {
      this.#subsecciones.set(id, {
        boton: document.querySelector(`[data-subseccion-boton="${id}"]`),
        panel: document.querySelector(`[data-subseccion-datos="${id}"]`),
        controlador,
      });
    }
    this.#activa = this.#subsecciones.keys().next().value ?? null;
  }

  iniciar() {
    const ids = [...this.#subsecciones.keys()];
    ids.forEach((id, i) => {
      const { boton, controlador } = this.#subsecciones.get(id);
      controlador.iniciar();
      boton.addEventListener("click", () => this.#elegir(id));
      boton.addEventListener("keydown", (e) => {
        const j = { ArrowDown: (i + 1) % ids.length, ArrowUp: (i - 1 + ids.length) % ids.length }[e.key];
        if (j === undefined) return;
        e.preventDefault();
        this.#elegir(ids[j]);
        this.#subsecciones.get(ids[j]).boton.focus();
      });
    });
  }

  mostrar() {
    if (this.#activa) this.#elegir(this.#activa, true);
  }

  #elegir(id, forzar = false) {
    if (id === this.#activa && !forzar) return;
    this.#activa = id;
    for (const [otro, { boton, panel }] of this.#subsecciones) {
      const activa = otro === id;
      boton.setAttribute("aria-selected", String(activa));
      boton.tabIndex = activa ? 0 : -1;
      panel.hidden = !activa;
    }
    this.#subsecciones.get(id).controlador.mostrar();
  }
}
