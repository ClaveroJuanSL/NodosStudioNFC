// Tests de src/lib/seguridad.js: CSRF, autenticación del admin y JWT de Access.
// Para el JWT generamos un par de claves RSA propio y "hacemos de Cloudflare":
// así probamos la verificación real de firma sin depender de internet.

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  autenticarAdmin,
  compararEnTiempoConstante,
  verificarJwtDeAccess,
  verificarOrigen,
} from "../src/lib/seguridad.js";

const TOKEN = "t".repeat(64);

describe("verificarOrigen (CSRF)", () => {
  const request = (headers) => new Request("https://nodos.example/api/x", { method: "POST", headers });

  it("acepta el mismo origen", () => {
    verificarOrigen(request({ Origin: "https://nodos.example", "Sec-Fetch-Site": "same-origin" }));
  });

  it("rechaza origen ausente, ajeno o parecido", () => {
    for (const origen of [undefined, "https://evil.example", "http://nodos.example", "https://nodos.example.evil.com", "null"]) {
      const headers = origen ? { Origin: origen } : {};
      assert.throws(() => verificarOrigen(request(headers)), { status: 403 }, String(origen));
    }
  });

  it("rechaza Sec-Fetch-Site cross-site aunque el Origin coincida", () => {
    assert.throws(() => verificarOrigen(request({ Origin: "https://nodos.example", "Sec-Fetch-Site": "cross-site" })), {
      status: 403,
    });
  });
});

describe("compararEnTiempoConstante", () => {
  it("compara contenido y largo", () => {
    assert.equal(compararEnTiempoConstante(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
    assert.equal(compararEnTiempoConstante(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
    assert.equal(compararEnTiempoConstante(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
  });
});

describe("autenticarAdmin", () => {
  const request = (url, token) =>
    new Request(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const envLocal = { ENTORNO: "desarrollo", ADMIN_TOKEN: TOKEN };

  it("en localhost con ENTORNO=desarrollo alcanza con el token", async () => {
    await autenticarAdmin(request("http://localhost:8787/api/admin/enlaces", TOKEN), envLocal);
  });

  it("rechaza token ausente o incorrecto con 401", async () => {
    await assert.rejects(autenticarAdmin(request("http://localhost:8787/x"), envLocal), { status: 401 });
    await assert.rejects(autenticarAdmin(request("http://localhost:8787/x", "x".repeat(64)), envLocal), { status: 401 });
  });

  it("falla cerrado si ADMIN_TOKEN es corto o no existe", async () => {
    for (const ADMIN_TOKEN of [undefined, "CAMBIAME"]) {
      await assert.rejects(
        autenticarAdmin(request("http://localhost:8787/x", TOKEN), { ENTORNO: "desarrollo", ADMIN_TOKEN }),
        { status: 503 },
      );
    }
  });

  it("ENTORNO=desarrollo NO saltea Access si el host no es local", async () => {
    await assert.rejects(autenticarAdmin(request("https://nodos.example/x", TOKEN), envLocal), { status: 503 });
  });

  it("en producción exige el JWT de Access", async () => {
    const env = { ENTORNO: "produccion", ADMIN_TOKEN: TOKEN, ACCESS_TEAM_DOMAIN: "equipo.cloudflareaccess.com", ACCESS_AUD: "aud" };
    await assert.rejects(autenticarAdmin(request("https://nodos.example/x", TOKEN), env), { status: 403 });
  });
});

describe("verificarJwtDeAccess", () => {
  const EQUIPO = "nodos.cloudflareaccess.com";
  const AUDIENCIA = "aud-de-la-app";
  let clavePrivada;
  let jwkPublica;

  before(async () => {
    const par = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    clavePrivada = par.privateKey;
    jwkPublica = { ...(await crypto.subtle.exportKey("jwk", par.publicKey)), kid: "clave-1", alg: "RS256" };
  });

  const b64url = (objeto) => Buffer.from(JSON.stringify(objeto)).toString("base64url");
  const ahora = () => Math.floor(Date.now() / 1000);
  const contenidoValido = () => ({ iss: `https://${EQUIPO}`, aud: [AUDIENCIA], exp: ahora() + 300, email: "vos@ejemplo.com" });

  async function firmar(contenido, encabezado = { alg: "RS256", kid: "clave-1" }) {
    const datos = `${b64url(encabezado)}.${b64url(contenido)}`;
    const firma = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", clavePrivada, new TextEncoder().encode(datos));
    return `${datos}.${Buffer.from(firma).toString("base64url")}`;
  }

  const verificar = (jwt, opciones = {}) =>
    verificarJwtDeAccess(jwt, { equipo: EQUIPO, audiencia: AUDIENCIA, obtenerClaves: async () => [jwkPublica], ...opciones });

  it("acepta un JWT válido y devuelve su contenido", async () => {
    const contenido = await verificar(await firmar(contenidoValido()));
    assert.equal(contenido.email, "vos@ejemplo.com");
  });

  it("rechaza audiencia, emisor o vencimiento incorrectos", async () => {
    const casos = [
      { ...contenidoValido(), aud: ["otra-app"] },
      { ...contenidoValido(), iss: "https://otro.cloudflareaccess.com" },
      { ...contenidoValido(), exp: ahora() - 10 },
      { ...contenidoValido(), exp: undefined },
      { ...contenidoValido(), nbf: ahora() + 3600 },
    ];
    for (const contenido of casos) await assert.rejects(verificar(await firmar(contenido)), { status: 403 });
  });

  it("rechaza un JWT alterado después de firmado", async () => {
    const [encabezado, , firma] = (await firmar(contenidoValido())).split(".");
    const alterado = `${encabezado}.${b64url({ ...contenidoValido(), email: "atacante@ejemplo.com" })}.${firma}`;
    await assert.rejects(verificar(alterado), { status: 403 });
  });

  it('rechaza alg "none", kid desconocido y basura', async () => {
    const sinFirma = `${b64url({ alg: "none", kid: "clave-1" })}.${b64url(contenidoValido())}.`;
    await assert.rejects(verificar(sinFirma), { status: 403 });
    await assert.rejects(verificar(await firmar(contenidoValido(), { alg: "RS256", kid: "otra" })), { status: 403 });
    for (const basura of [undefined, "", "a.b", "a.b.c.d", "!!!.###.$$$"]) {
      await assert.rejects(verificar(basura), { status: 403 }, String(basura));
    }
  });

  it("falla cerrado si el dominio del equipo tiene un formato inválido", async () => {
    await assert.rejects(verificar(await firmar(contenidoValido()), { equipo: "sitio-malo.com" }), { status: 503 });
  });
});
