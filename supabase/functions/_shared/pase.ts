// Pase de participante: JWT HS256 firmado con TOKEN_SECRETO usando Web Crypto (sin dependencias).
// Claims: rol "participante", jti aleatorio, iat y exp (3 horas).

const codificador = new TextEncoder();

function aBase64Url(bytes: Uint8Array): string {
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deBase64Url(texto: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(texto)) throw new Error("base64url");
  const relleno = texto.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((texto.length + 3) % 4);
  const binario = atob(relleno);
  return Uint8Array.from(binario, (c) => c.charCodeAt(0));
}

const jsonA64 = (objeto: unknown) => aBase64Url(codificador.encode(JSON.stringify(objeto)));

export class PaseParticipante {
  static DURACION_S = 3 * 60 * 60;
  static ROL = "participante";
  static TOLERANCIA_RELOJ_S = 60;

  #clave: Promise<CryptoKey>;

  constructor(secreto: string) {
    this.#clave = crypto.subtle.importKey(
      "raw", codificador.encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"],
    );
  }

  async emitir(ahoraMs = Date.now()): Promise<string> {
    const iat = Math.floor(ahoraMs / 1000);
    const cabecera = jsonA64({ alg: "HS256", typ: "JWT" });
    const datos = jsonA64({ rol: PaseParticipante.ROL, jti: crypto.randomUUID(), iat, exp: iat + PaseParticipante.DURACION_S });
    const firma = new Uint8Array(await crypto.subtle.sign("HMAC", await this.#clave, codificador.encode(`${cabecera}.${datos}`)));
    return `${cabecera}.${datos}.${aBase64Url(firma)}`;
  }

  /** true solo si la firma, el algoritmo, el rol y las fechas son válidos. Cualquier duda: false. */
  async verificar(token: string | null, ahoraMs = Date.now()): Promise<boolean> {
    try {
      if (!token) return false;
      const partes = token.split(".");
      if (partes.length !== 3) return false;
      const [cabecera, datos, firma] = partes;
      const h = JSON.parse(new TextDecoder().decode(deBase64Url(cabecera)));
      if (h?.alg !== "HS256" || h?.typ !== "JWT") return false; // nunca "none" ni otros algoritmos
      // verify de HMAC en Web Crypto compara en tiempo constante
      const valida = await crypto.subtle.verify("HMAC", await this.#clave, deBase64Url(firma), codificador.encode(`${cabecera}.${datos}`));
      if (!valida) return false;
      const p = JSON.parse(new TextDecoder().decode(deBase64Url(datos)));
      const ahora = Math.floor(ahoraMs / 1000);
      return p?.rol === PaseParticipante.ROL &&
        typeof p?.jti === "string" && /^[0-9a-f-]{36}$/.test(p.jti) &&
        Number.isInteger(p?.iat) && Number.isInteger(p?.exp) &&
        p.iat <= ahora + PaseParticipante.TOLERANCIA_RELOJ_S &&
        p.exp > ahora &&
        p.exp - p.iat <= PaseParticipante.DURACION_S;
    } catch {
      return false;
    }
  }
}
