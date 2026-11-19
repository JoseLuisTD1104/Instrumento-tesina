// Huella de red para limitar intentos sin guardar la IP: HMAC-SHA256(IP_SECRETO, primera IP de
// x-forwarded-for) en hexadecimal. La IP real nunca se guarda ni se registra.

export class HuellaDeRed {
  #clave: Promise<CryptoKey>;

  constructor(secreto: string) {
    this.#clave = crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
  }

  async de(peticion: Request): Promise<string> {
    const primera = (peticion.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    // Valor acotado: una cadena rara o vacía cae en una huella común, que también se limita.
    const ip = /^[0-9A-Fa-f:.]{2,45}$/.test(primera) ? primera : "desconocida";
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await this.#clave, new TextEncoder().encode(ip)));
    return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}
