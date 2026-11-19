// Código de acceso de 8 dígitos tipo TOTP (RFC 6238 sobre HOTP de RFC 4226) con HMAC-SHA256.
// La ventana es floor(segundos_unix / 300). La hora válida es siempre la del servidor.

export class GeneradorDeCodigo {
  static PASO_S = 300;
  static DIGITOS = 8;

  #clave: Promise<CryptoKey>;

  constructor(secreto: string) {
    this.#clave = crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
  }

  static ventanaDe(ahoraMs: number): number {
    return Math.floor(ahoraMs / 1000 / GeneradorDeCodigo.PASO_S);
  }

  /** Segundos transcurridos dentro de la ventana actual (0 a 300). */
  static segundosEnVentana(ahoraMs: number): number {
    return (ahoraMs / 1000) % GeneradorDeCodigo.PASO_S;
  }

  static segundosRestantes(ahoraMs: number): number {
    return GeneradorDeCodigo.PASO_S - GeneradorDeCodigo.segundosEnVentana(ahoraMs);
  }

  /** HOTP(K, ventana) con truncamiento dinámico, a 8 dígitos. */
  async codigo(ventana: number): Promise<string> {
    const contador = new Uint8Array(8);
    let v = BigInt(ventana);
    for (let i = 7; i >= 0; i--) { contador[i] = Number(v & 0xffn); v >>= 8n; }
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await this.#clave, contador));
    const desplazamiento = mac[mac.length - 1] & 0x0f;
    const binario = ((mac[desplazamiento] & 0x7f) << 24) | (mac[desplazamiento + 1] << 16) |
      (mac[desplazamiento + 2] << 8) | mac[desplazamiento + 3];
    return String(binario % 10 ** GeneradorDeCodigo.DIGITOS).padStart(GeneradorDeCodigo.DIGITOS, "0");
  }

  /** Comparación en tiempo constante para cadenas del mismo largo. */
  static iguales(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diferencia = 0;
    for (let i = 0; i < a.length; i++) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diferencia === 0;
  }
}
