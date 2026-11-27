// Pruebas de admin-resultados con datos inventados (ningún dato real). PostgREST y Auth se simulan con un
// fetch falso que, como Supabase, corta en 1000 filas por consulta. Ejecutar desde la raíz del repositorio:
//   node --experimental-strip-types --no-warnings supabase/pruebas/admin-resultados.test.ts
import assert from "node:assert/strict";

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno = { serve: () => {} };
const { manejar } = await import("../functions/admin-resultados/index.ts");

const ORIGEN = "https://ejemplo.github.io";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const N_VIDEOS = 40; // más de 12
const N_PART = 20;
const TOPE_SUPABASE = 1000;

type Fila = Record<string, unknown>;
const hex = (n: number, largo: number) => n.toString(16).padStart(largo, "0");
const idVideo = (n: number) => `${hex(n, 8)}-0000-4000-8000-000000000000`;
const idActor = (n: number) => `${hex(n, 8)}-1111-4111-8111-111111111111`;
const ALFA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const codigo = (n: number) => `P-AAAAAA${ALFA[Math.floor(n / 32)]}${ALFA[n % 32]}`;

/** Base inventada. P0: conoce al actor del video 3. P1: se quedó en la evaluación. P2: retiró sus datos.
 * P3: no contestó la escala del video 5. P4: sin deepfakes_previos. Video 40: sin clasificar. */
function baseInventada(): Record<string, Fila[]> {
  const t: Record<string, Fila[]> = {
    videos: [], clasificacion_videos: [], respuestas_video: [], respuestas_evaluacion: [], respuestas_conoce: [],
    perfil_participante: [], progreso_participante: [], retiros_participante: [],
    participantes: [], // con datos personales falsos: la función no debe leerla nunca
  };
  for (let v = 1; v <= N_VIDEOS; v++) {
    t.videos.push({ id: idVideo(v), numero_video: v, actor_id: idActor(v), publicado: true });
    if (v < N_VIDEOS) t.clasificacion_videos.push({ video_id: idVideo(v), origen: v % 2 ? "ia" : "real", tipo: v % 3 ? "normal" : "ingenieria_social" });
  }
  const t0 = Date.parse("2026-11-01T10:00:00Z");
  for (let p = 0; p < N_PART; p++) {
    const c = codigo(p);
    t.participantes.push({ codigo_participante: c, nombre: "NOMBRE_SECRETO", matricula: "MATSECRETA1" });
    t.perfil_participante.push({ codigo_participante: c, carrera: "TI", edad: 20 + (p % 5), semestre: 1 + (p % 9), deepfakes_previos: p === 4 ? null : p % 2 === 0 });
    t.progreso_participante.push({ codigo_participante: c, etapa: p === 1 ? "evaluacion" : "fin" });
    for (let v = 1; v <= N_VIDEOS; v++) {
      const creado = new Date(t0 + p * 1000).toISOString();
      t.respuestas_video.push({ codigo_participante: c, video_id: idVideo(v), pregunta: "haria", marcado: (p + v) % 4 === 0, creado_en: creado });
      t.respuestas_video.push({ codigo_participante: c, video_id: idVideo(v), pregunta: "deepfake", marcado: (p + v) % 3 === 0, creado_en: creado });
      const contesto = !(p === 1 && v > 10) && !(p === 3 && v === 5);
      if (contesto) t.respuestas_evaluacion.push({ codigo_participante: c, video_id: idVideo(v), respuesta: 1 + ((p + v) % 6), creado_en: creado });
      t.respuestas_conoce.push({ codigo_participante: c, actor_id: idActor(v), conoce: p === 0 && v === 3, creado_en: creado });
    }
  }
  t.retiros_participante.push({ codigo_participante: codigo(2), retirado_en: "2026-11-20T00:00:00Z" });
  return t;
}

let tablas = baseInventada();
let usuario = ADMIN;
const leidas = new Set<string>();

function filtrar(filas: Fila[], p: URLSearchParams): Fila[] {
  let r = filas.filter((f) => {
    for (const [k, v] of p) {
      if (["select", "order", "limit", "offset"].includes(k)) continue;
      if (v.startsWith("eq.")) { if (String(f[k]) !== v.slice(3)) return false; }
      else if (v.startsWith("in.(")) { if (!v.slice(4, -1).split(",").includes(String(f[k]))) return false; }
      else if (v === "not.is.null") { if (f[k] == null) return false; }
      else throw new Error("filtro no simulado: " + v);
    }
    return true;
  });
  const orden = (p.get("order") ?? "").split(",").filter(Boolean).map((o) => o.split(".")[0]);
  r = [...r].sort((a, b) => {
    for (const k of orden) { const x = String(a[k]), y = String(b[k]); if (x !== y) return x < y ? -1 : 1; }
    return 0;
  });
  const desde = Number(p.get("offset") ?? 0);
  const limite = Math.min(Number(p.get("limit") ?? TOPE_SUPABASE), TOPE_SUPABASE);
  const select = (p.get("select") ?? "*").split(",");
  return r.slice(desde, desde + limite).map((f) => (select[0] === "*" ? f : Object.fromEntries(select.map((s) => [s, f[s] ?? null]))));
}

globalThis.fetch = (async (entrada: string | URL | Request) => {
  const url = new URL(String(entrada));
  if (url.pathname === "/auth/v1/user") return Response.json({ id: usuario });
  const tabla = url.pathname.replace("/rest/v1/", "");
  leidas.add(tabla);
  if (!(tabla in tablas)) return Response.json({ code: "PGRST205" }, { status: 404 });
  return Response.json(filtrar(tablas[tabla], url.searchParams));
}) as typeof fetch;

const entorno: Record<string, string> = {
  ORIGEN_PERMITIDO: ORIGEN, SUPABASE_URL: "https://proyecto.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "eyJservicio.falso.x", ADMIN_UID: ADMIN,
};
function pedir(cuerpo: unknown = { accion: "base" }, { origen = ORIGEN, token = "eyJtoken.del.administrador" } = {}) {
  const headers: Record<string, string> = { Origin: origen, "Content-Type": "application/json", apikey: "sb_publishable_falsa" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return manejar(new Request("https://proyecto.supabase.co/functions/v1/admin-resultados", { method: "POST", headers, body: JSON.stringify(cuerpo) }), (n) => entorno[n]);
}

let fallas = 0;
async function prueba(nombre: string, fn: () => Promise<void>) {
  tablas = baseInventada(); usuario = ADMIN; leidas.clear();
  try { await fn(); console.log("ok   ", nombre); } catch (e) { fallas++; console.log("FALLA", nombre, "\n", e); }
}
// deno-lint-ignore no-explicit-any
const leerBase = async (): Promise<any> => { const r = await pedir(); assert.equal(r.status, 200); return await r.json(); };
// deno-lint-ignore no-explicit-any
const filasDe = (b: any, p: number) => b.filas.filter((f: any) => f.codigo_participante === codigo(p));

const CAMPOS = ["codigo_participante", "numero_video", "origen", "tipo", "marco_deepfake_p8", "obedeceria", "escala_p9", "carrera",
  "edad", "semestre", "deepfakes_previos", "excl_conoce_actor", "excl_sesion_incompleta", "excl_retiro"];

await prueba("rechaza a quien no es administrador (401) y a otro origen (403)", async () => {
  usuario = OTRO;
  assert.equal((await pedir()).status, 401);
  assert.equal((await pedir(undefined, { token: "" })).status, 401);
  assert.equal((await pedir(undefined, { origen: "https://otro.example" })).status, 403);
  assert.ok(![...leidas].some((t) => t !== "auth"), "no debe leer tablas sin administrador");
});

await prueba("cuerpo distinto de { accion: 'base' } → 400", async () => {
  assert.equal((await pedir({ accion: "base", extra: 1 })).status, 400);
  assert.equal((await pedir({ accion: "otra" })).status, 400);
});

await prueba("más de 12 videos y más de 1000 filas por tabla (lectura por páginas)", async () => {
  const b = await leerBase();
  assert.equal(b.version, 1);
  assert.equal(b.filas.length, N_PART * N_VIDEOS); // 800 filas salen de 1600 respuestas_video
  assert.equal(b.resumen.filas, N_PART * N_VIDEOS);
  assert.equal(b.resumen.participantes, N_PART);
  assert.equal(b.resumen.participantes_registrados, N_PART);
  assert.equal(b.resumen.videos, N_VIDEOS);
  assert.deepEqual(Object.keys(b.filas[0]), CAMPOS);
  assert.deepEqual(filasDe(b, 7).map((f: { numero_video: number }) => f.numero_video), Array.from({ length: N_VIDEOS }, (_, i) => i + 1));
});

await prueba("conoce al actor: solo ese video de ese participante", async () => {
  const b = await leerBase();
  // deno-lint-ignore no-explicit-any
  const marcadas = b.filas.filter((f: any) => f.excl_conoce_actor);
  assert.equal(marcadas.length, 1);
  assert.equal(marcadas[0].codigo_participante, codigo(0));
  assert.equal(marcadas[0].numero_video, 3);
});

await prueba("sesión incompleta: todas las filas del participante, con nulos en la escala que falta", async () => {
  const b = await leerBase();
  const p1 = filasDe(b, 1);
  assert.equal(p1.length, N_VIDEOS);
  assert.ok(p1.every((f: { excl_sesion_incompleta: boolean }) => f.excl_sesion_incompleta));
  assert.equal(p1.filter((f: { escala_p9: unknown }) => f.escala_p9 === null).length, N_VIDEOS - 10);
  // deno-lint-ignore no-explicit-any
  assert.equal(b.filas.filter((f: any) => f.excl_sesion_incompleta).length, N_VIDEOS);
});

await prueba("sin fila de progreso cuenta como sesión incompleta", async () => {
  tablas.progreso_participante = tablas.progreso_participante.filter((f) => f.codigo_participante !== codigo(9));
  const b = await leerBase();
  assert.ok(filasDe(b, 9).every((f: { excl_sesion_incompleta: boolean }) => f.excl_sesion_incompleta));
});

await prueba("retiro: todas las filas del participante y solo las suyas", async () => {
  const b = await leerBase();
  // deno-lint-ignore no-explicit-any
  const marcadas = b.filas.filter((f: any) => f.excl_retiro);
  assert.equal(marcadas.length, N_VIDEOS);
  assert.ok(marcadas.every((f: { codigo_participante: string }) => f.codigo_participante === codigo(2)));
});

await prueba("respuesta faltante: null donde falta, sin inventar valores", async () => {
  const b = await leerBase();
  const fila = filasDe(b, 3).find((f: { numero_video: number }) => f.numero_video === 5);
  assert.equal(fila.escala_p9, null);
  assert.equal(typeof fila.marco_deepfake_p8, "boolean");
  assert.equal(typeof fila.obedeceria, "boolean");
  assert.ok(filasDe(b, 4).every((f: { deepfakes_previos: unknown }) => f.deepfakes_previos === null));
  // Sin respuestas de "haria" para un participante: obedeceria null, la fila sigue existiendo.
  tablas.respuestas_video = tablas.respuestas_video.filter((f) => !(f.codigo_participante === codigo(6) && f.pregunta === "haria"));
  const b2 = await leerBase();
  const p6 = filasDe(b2, 6);
  assert.equal(p6.length, N_VIDEOS);
  assert.ok(p6.every((f: { obedeceria: unknown }) => f.obedeceria === null));
});

await prueba("video sin clasificar y video borrado quedan en el resumen", async () => {
  tablas.videos = tablas.videos.filter((f) => f.numero_video !== 39);
  const b = await leerBase();
  assert.equal(b.resumen.videos_sin_clasificar, 1);
  assert.deepEqual(b.resumen.numeros_sin_clasificar, [40]);
  assert.equal(b.resumen.filas_sin_numero_video, N_PART);
  // deno-lint-ignore no-explicit-any
  assert.ok(b.filas.filter((f: any) => f.numero_video === 40).every((f: any) => f.origen === null && f.tipo === null));
});

await prueba("nunca lee participantes ni devuelve nombre o matrícula", async () => {
  const texto = JSON.stringify(await leerBase());
  assert.ok(!leidas.has("participantes"));
  assert.ok(!/NOMBRE_SECRETO|MATSECRETA1|matricula|"nombre"/.test(texto));
});

await prueba("sin la tabla de retiros falla cerrada (503 falta_tabla_retiros)", async () => {
  delete tablas.retiros_participante;
  const r = await pedir();
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "falta_tabla_retiros" });
});

await prueba("una fila ilegible detiene todo (503)", async () => {
  tablas.respuestas_evaluacion[0].respuesta = 9;
  assert.equal((await pedir()).status, 503);
});

console.log(fallas ? `\n${fallas} prueba(s) fallaron` : "\nTodas las pruebas pasaron");
if (fallas) throw new Error("pruebas fallidas");
