// Tests de src/lib/codigos.js: generación y verificación de códigos de activación.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALFABETO_CODIGO,
  LARGO_CODIGO,
  generarCodigo,
  generarSal,
  hashearCodigo,
  normalizarCodigo,
  verificarCodigo,
} from "../src/lib/codigos.js";

describe("alfabeto", () => {
  it("tiene 31 caracteres únicos y ninguno ambiguo", () => {
    assert.equal(ALFABETO_CODIGO.length, 31);
    assert.equal(new Set(ALFABETO_CODIGO).size, 31);
    for (const ambiguo of ["0", "O", "1", "I", "L"]) assert.equal(ALFABETO_CODIGO.includes(ambiguo), false, ambiguo);
  });
});

describe("generarCodigo", () => {
  const muestras = Array.from({ length: 20000 }, generarCodigo);

  it("genera 6 caracteres del alfabeto", () => {
    for (const codigo of muestras) {
      assert.equal(codigo.length, LARGO_CODIGO);
      for (const caracter of codigo) assert.ok(ALFABETO_CODIGO.includes(caracter), codigo);
    }
  });

  it("no repite códigos en 20.000 muestras (887 millones posibles)", () => {
    // Por la "paradoja del cumpleaños" la chance de UNA repetición acá es ~20%.
    // Toleramos alguna, pero muchas indicarían un generador roto.
    assert.ok(new Set(muestras).size > muestras.length - 5);
  });

  it("usa todos los caracteres de forma pareja (sin sesgo de módulo)", () => {
    const conteo = new Map();
    for (const codigo of muestras) for (const c of codigo) conteo.set(c, (conteo.get(c) ?? 0) + 1);
    const esperado = (muestras.length * LARGO_CODIGO) / ALFABETO_CODIGO.length; // ~3871
    assert.equal(conteo.size, ALFABETO_CODIGO.length);
    for (const [caracter, veces] of conteo) {
      // ±10% es muy holgado para 120.000 caracteres; un sesgo real se notaría.
      assert.ok(Math.abs(veces - esperado) < esperado * 0.1, `${caracter}: ${veces}`);
    }
  });
});

describe("normalizarCodigo", () => {
  it("acepta minúsculas, espacios y guiones", () => {
    assert.equal(normalizarCodigo("abc-def"), "ABCDEF");
    assert.equal(normalizarCodigo(" ab cd ef "), "ABCDEF");
  });

  it("rechaza caracteres ambiguos, largos incorrectos y no-strings", () => {
    for (const texto of ["ABCDE0", "ABCDE1", "ABCDEO", "ABCDE", "ABCDEFG", "", null, 123456]) {
      assert.equal(normalizarCodigo(texto), null, String(texto));
    }
  });
});

describe("hash y verificación", () => {
  it("la sal cambia el hash aunque el código sea el mismo", async () => {
    const [sal1, sal2] = [generarSal(), generarSal()];
    assert.equal(sal1.length, 32); // 16 bytes en hex
    assert.notEqual(await hashearCodigo("ABCDEF", sal1), await hashearCodigo("ABCDEF", sal2));
  });

  it("verifica el código correcto y rechaza los demás", async () => {
    const sal = generarSal();
    const hash = await hashearCodigo("ABCDEF", sal);
    assert.equal(await verificarCodigo("ABCDEF", sal, hash), true);
    assert.equal(await verificarCodigo("ABCDEG", sal, hash), false);
    assert.equal(await verificarCodigo("ABCDEF", generarSal(), hash), false);
  });
});
