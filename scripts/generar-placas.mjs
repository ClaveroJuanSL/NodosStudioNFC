#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────
// generar-placas.mjs — Crea un lote de placas pregeneradas.
//
//   npm run generar -- 50                                   → KV LOCAL (pruebas)
//   npm run generar -- 50 --remoto --url-base https://TU-DOMINIO   → PRODUCCIÓN
//
// Qué hace:
//   1. Busca en KV el último ID "nds-XXXXX" que exista.
//   2. Genera N IDs consecutivos, cada uno con un código aleatorio.
//   3. Escribe el CSV en salida/ (id, código, url, url de edición).
//   4. Sube a KV los registros (con el HASH del código, nunca el código).
//
// El CSV es el ÚNICO lugar donde los códigos existen en texto plano.
// Guardalo en un lugar seguro y borralo cuando termines de imprimir.
// ─────────────────────────────────────────────────────────────────

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

// Reutilizamos EXACTAMENTE el mismo código que usa el Worker. Si el hash se
// calculara distinto acá y allá, ninguna placa se podría activar.
import { PREFIJO_CLAVE, metadataDe, nuevaPlaca } from "../src/lib/almacen.js";
import { generarCodigo, generarSal, hashearCodigo } from "../src/lib/codigos.js";
import { PREFIJO_PLACA } from "../src/lib/validacion.js";

const RAIZ = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER = join(RAIZ, "node_modules", "wrangler", "bin", "wrangler.js");
const MAXIMO_POR_LOTE = 1000;
const DIGITOS_ID = 5; // nds-00001

// ─── Argumentos ──────────────────────────────────────────────────

function leerArgumentos(argumentos) {
  const opciones = { cantidad: NaN, remoto: false, urlBase: null };
  for (let i = 0; i < argumentos.length; i++) {
    const argumento = argumentos[i];
    if (argumento === "--remoto") opciones.remoto = true;
    else if (argumento === "--url-base") opciones.urlBase = argumentos[++i];
    else if (argumento.startsWith("--url-base=")) opciones.urlBase = argumento.slice("--url-base=".length);
    else if (/^\d+$/.test(argumento)) opciones.cantidad = Number(argumento);
    else throw new Error(`Argumento desconocido: ${argumento}`);
  }

  if (!Number.isInteger(opciones.cantidad) || opciones.cantidad < 1 || opciones.cantidad > MAXIMO_POR_LOTE) {
    throw new Error(`Indicá cuántas placas generar (entre 1 y ${MAXIMO_POR_LOTE}). Ej.: npm run generar -- 50`);
  }

  if (opciones.remoto) {
    // En producción la URL base es obligatoria y tiene que ser https: es lo
    // que se va a imprimir en el QR y grabar en el chip, para siempre.
    if (!opciones.urlBase || !/^https:\/\/[^/]+$/.test(opciones.urlBase)) {
      throw new Error("Con --remoto indicá --url-base https://TU-DOMINIO (sin barra final).");
    }
  } else {
    opciones.urlBase ??= "http://localhost:8787";
  }
  opciones.urlBase = opciones.urlBase.replace(/\/+$/, "");
  return opciones;
}

// ─── Wrangler ────────────────────────────────────────────────────

/**
 * Ejecuta wrangler con Node directamente (sin "npx" ni shell): así los
 * argumentos llegan tal cual, sin problemas de comillas ni espacios en
 * rutas de Windows ("Nodos Studio").
 */
function wrangler(argumentos) {
  const resultado = spawnSync(process.execPath, [WRANGLER, ...argumentos], {
    cwd: RAIZ,
    encoding: "utf8",
  });
  if (resultado.status !== 0) {
    throw new Error(`wrangler ${argumentos.slice(0, 3).join(" ")} falló:\n${resultado.stderr || resultado.stdout}`);
  }
  return resultado.stdout;
}

function ultimoNumeroDePlaca(modo) {
  const salida = wrangler(["kv", "key", "list", "--binding", "ENLACES", modo, "--prefix", PREFIJO_CLAVE + PREFIJO_PLACA]);
  const claves = JSON.parse(salida.slice(salida.indexOf("[")));
  let maximo = 0;
  for (const { name } of claves) {
    const numero = Number(name.slice((PREFIJO_CLAVE + PREFIJO_PLACA).length));
    if (Number.isInteger(numero) && numero > maximo) maximo = numero;
  }
  return maximo;
}

// ─── CSV ─────────────────────────────────────────────────────────

/** Escapa un valor CSV: si tiene coma, comillas o salto de línea, va entre comillas. */
function campoCsv(valor) {
  const texto = String(valor);
  return /[",\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

function armarCsv(placas) {
  const filas = [["id", "codigo", "url", "url_edicion"]];
  for (const placa of placas) filas.push([placa.id, placa.codigo, placa.url, placa.urlEdicion]);
  // \r\n y BOM: Excel en Windows abre bien los acentos y separa las filas.
  return "﻿" + filas.map((fila) => fila.map(campoCsv).join(",")).join("\r\n") + "\r\n";
}

// ─── Programa principal ──────────────────────────────────────────

async function confirmarProduccion(cantidad, urlBase) {
  const consola = createInterface({ input: process.stdin, output: process.stdout });
  const respuesta = await consola.question(
    `\n⚠️  Vas a crear ${cantidad} placas en PRODUCCIÓN con URLs ${urlBase}/r/...\n` +
      `   Escribí SI (en mayúsculas) para continuar: `,
  );
  consola.close();
  return respuesta.trim() === "SI";
}

async function main() {
  const opciones = leerArgumentos(process.argv.slice(2));
  const modo = opciones.remoto ? "--remote" : "--local";

  if (opciones.remoto && !(await confirmarProduccion(opciones.cantidad, opciones.urlBase))) {
    console.log("Cancelado. No se creó nada.");
    return;
  }

  console.log(`Buscando el último ID en KV (${opciones.remoto ? "producción" : "local"})...`);
  const desde = ultimoNumeroDePlaca(modo) + 1;

  // 1. Generar códigos y registros en memoria.
  const placas = [];
  const entradasKv = [];
  for (let numero = desde; numero < desde + opciones.cantidad; numero++) {
    const id = PREFIJO_PLACA + String(numero).padStart(DIGITOS_ID, "0");
    const codigo = generarCodigo();
    const sal = generarSal();
    const registro = nuevaPlaca({ codigo_hash: await hashearCodigo(codigo, sal), sal });

    placas.push({ id, codigo, url: `${opciones.urlBase}/r/${id}`, urlEdicion: `${opciones.urlBase}/e/${id}` });
    entradasKv.push({ key: PREFIJO_CLAVE + id, value: JSON.stringify(registro), metadata: metadataDe(registro) });
  }

  // 2. Primero el CSV, después KV. Si KV falla, borramos el CSV y no pasa
  //    nada. Al revés (KV primero) un fallo al escribir el CSV dejaría placas
  //    cargadas cuyos códigos nadie conoce.
  const carpetaSalida = join(RAIZ, "salida");
  mkdirSync(carpetaSalida, { recursive: true });
  const marcaDeTiempo = new Date().toISOString().replace(/[:.]/g, "-");
  const archivoCsv = join(carpetaSalida, `placas-${placas[0].id}-a-${placas.at(-1).id}-${marcaDeTiempo}.csv`);
  writeFileSync(archivoCsv, armarCsv(placas), { encoding: "utf8", mode: 0o600 });

  // 3. Subir a KV con un archivo temporal FUERA del repo (tiene hashes).
  const carpetaTemporal = mkdtempSync(join(tmpdir(), "nodos-placas-"));
  const archivoJson = join(carpetaTemporal, "lote.json");
  try {
    writeFileSync(archivoJson, JSON.stringify(entradasKv), { encoding: "utf8", mode: 0o600 });
    console.log(`Subiendo ${entradasKv.length} placas a KV...`);
    wrangler(["kv", "bulk", "put", archivoJson, "--binding", "ENLACES", modo]);
  } catch (error) {
    rmSync(archivoCsv, { force: true });
    throw error;
  } finally {
    rmSync(carpetaTemporal, { recursive: true, force: true });
  }

  console.log(`\n✅ ${placas.length} placas creadas: ${placas[0].id} → ${placas.at(-1).id}`);
  console.log(`📄 CSV: ${archivoCsv}`);
  console.log("🔒 El CSV tiene los códigos en texto plano: guardalo en un lugar seguro y");
  console.log("   borralo cuando termines de imprimir las tarjetas. Está en .gitignore.");
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}`);
  process.exitCode = 1;
});
