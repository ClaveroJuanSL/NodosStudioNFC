// Los headers de seguridad viven en DOS lugares (public/_headers para los
// estáticos y src/lib/respuestas.js para lo que genera el Worker).
// Este test falla si alguien cambia uno y se olvida del otro.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

import { HEADERS_DE_SEGURIDAD } from "../src/lib/respuestas.js";

/** Lee las líneas indentadas que siguen a una ruta en el formato _headers. */
function headersDeRuta(texto, ruta) {
  const lineas = texto.split(/\r?\n/);
  const inicio = lineas.findIndex((linea) => linea.trim() === ruta && !/^\s/.test(linea));
  assert.notEqual(inicio, -1, `No está la ruta ${ruta} en _headers`);

  const headers = {};
  for (const linea of lineas.slice(inicio + 1)) {
    if (!/^\s+\S/.test(linea)) break; // termina el bloque
    const separador = linea.indexOf(":");
    headers[linea.slice(0, separador).trim()] = linea.slice(separador + 1).trim();
  }
  return headers;
}

it("public/_headers y respuestas.js definen los mismos headers de seguridad", () => {
  const texto = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  assert.deepEqual(headersDeRuta(texto, "/*"), { ...HEADERS_DE_SEGURIDAD });
});

it("la CSP no permite scripts ni estilos inline", () => {
  const csp = HEADERS_DE_SEGURIDAD["Content-Security-Policy"];
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});
