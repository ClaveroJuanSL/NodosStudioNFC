// Tests de src/lib/validacion.js — se corren con `npm test` (node:test, sin dependencias).
// Cada caso "rechaza" es un intento real de saltear la validación.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  esIdDePlaca,
  esSlugValido,
  leerDominiosPermitidos,
  leerJson,
  validarCliente,
  validarDestino,
  validarSlugNuevo,
} from "../src/lib/validacion.js";

const DOMINIOS = leerDominiosPermitidos("google.com, www.google.com,g.page,maps.app.goo.gl,search.google.com");

describe("slugs", () => {
  it("acepta minúsculas, números y guiones hasta 40 caracteres", () => {
    for (const slug of ["panaderia-lopez", "a", "nds-00001", "x".repeat(40)]) {
      assert.equal(esSlugValido(slug), true, slug);
    }
  });

  it("rechaza todo lo demás (sin corregir)", () => {
    for (const slug of ["", "Panaderia", "x".repeat(41), "a b", "a/b", "../admin", "ñandu", "a_b", "a.b", null, 42]) {
      assert.equal(esSlugValido(slug), false, String(slug));
    }
  });

  it("reserva el prefijo nds- para las placas", () => {
    assert.throws(() => validarSlugNuevo("nds-12345"), { codigo: "slug_reservado" });
    assert.equal(validarSlugNuevo("cafe-central"), "cafe-central");
  });

  it("reconoce IDs de placa", () => {
    assert.equal(esIdDePlaca("nds-00001"), true);
    assert.equal(esIdDePlaca("nds-123"), false);
    assert.equal(esIdDePlaca("panaderia"), false);
  });
});

describe("destinos", () => {
  it("acepta links de reseñas de Google", () => {
    const validos = [
      "https://g.page/r/CaBcDeFgHiJk/review",
      "https://search.google.com/local/writereview?placeid=ChIJ123",
      "https://maps.app.goo.gl/AbC123",
      "https://www.google.com/maps/place/Panaderia/@-34.6,-58.4,17z",
      "https://www.google.com/search?q=panaderia#lrd=0x1:0x2,3",
      "https://google.com/maps?cid=123",
      "  https://g.page/r/x/review  ", // espacios alrededor: se recortan
    ];
    for (const url of validos) assert.equal(validarDestino(url, DOMINIOS).ok, true, url);
  });

  it("rechaza intentos de bypass", () => {
    const invalidos = [
      "http://g.page/r/x/review", // sin https
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://g.page.sitio-malo.com/r/x", // sufijo engañoso
      "https://sitio-malo.com/?g.page", // dominio en el query
      "https://google.com@sitio-malo.com/maps", // usuario@host
      "https://usuario:clave@g.page/r/x",
      "https://sitio-malo.com\\@g.page/r/x", // la barra invertida se trata como "/"
      "https://g.page:8443/r/x", // puerto no estándar
      "https://sites.google.com/view/phishing", // subdominio de google.com
      "https://docs.google.com/forms/d/x",
      "https://www.google.com/url?q=https://sitio-malo.com", // redirector de Google
      "https://www.google.com/mapsx", // no es /maps
      "https://google.com./maps", // punto final en el host
      "https://g.page/" + "x".repeat(500), // demasiado largo
      "no es una url",
      "",
      42,
      null,
    ];
    for (const url of invalidos) assert.equal(validarDestino(url, DOMINIOS).ok, false, String(url));
  });

  it("normaliza la URL guardada", () => {
    assert.equal(validarDestino("HTTPS://G.PAGE/r/x/review", DOMINIOS).url, "https://g.page/r/x/review");
  });
});

describe("cliente", () => {
  it("quita caracteres de control y recorta", () => {
    assert.equal(validarCliente("  Café\nCentral\t "), "CaféCentral");
    assert.equal(validarCliente(undefined), "");
  });

  it("rechaza tipos raros y textos largos", () => {
    assert.throws(() => validarCliente(123), { codigo: "cliente_invalido" });
    assert.throws(() => validarCliente("x".repeat(81)), { codigo: "cliente_invalido" });
  });
});

describe("leerJson", () => {
  const request = (cuerpo, tipo = "application/json") =>
    new Request("http://localhost/api", {
      method: "POST",
      headers: { "Content-Type": tipo },
      body: cuerpo,
    });

  it("lee un objeto con campos permitidos", async () => {
    assert.deepEqual(await leerJson(request('{"codigo":"ABC"}'), ["codigo"]), { codigo: "ABC" });
  });

  it("exige Content-Type JSON", async () => {
    await assert.rejects(leerJson(request("{}", "text/plain"), []), { status: 415 });
  });

  it("rechaza JSON roto, arrays y null", async () => {
    for (const cuerpo of ["{", "[1,2]", "null", '"texto"']) {
      await assert.rejects(leerJson(request(cuerpo), []), { codigo: "json_invalido" }, cuerpo);
    }
  });

  it("rechaza campos que no se esperaban", async () => {
    await assert.rejects(leerJson(request('{"codigo":"A","admin":true}'), ["codigo"]), { codigo: "campos_desconocidos" });
  });

  it("corta cuerpos de más de 10 KB", async () => {
    await assert.rejects(leerJson(request(JSON.stringify({ x: "a".repeat(11000) })), ["x"]), { status: 413 });
  });

  it("rechaza bytes que no son UTF-8 válido", async () => {
    const latin1 = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xed, 0x22, 0x7d]); // {"a":"í"} en Latin-1
    await assert.rejects(leerJson(request(latin1), ["a"]), { codigo: "json_invalido" });
  });
});
