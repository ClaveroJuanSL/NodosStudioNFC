// ─────────────────────────────────────────────────────────────────
// codigos.js — Códigos de activación de las placas.
//
// Lo usan DOS programas distintos:
//   • el Worker (para verificar el código que escribe el dueño del negocio)
//   • scripts/generar-placas.mjs (para crear los códigos en Node)
// Por eso solo usa la Web Crypto API (globalThis.crypto), que existe igual
// en Cloudflare Workers y en Node 20+.
// ─────────────────────────────────────────────────────────────────

import { bytesAHex, compararEnTiempoConstante, hexABytes, sha256 } from "./seguridad.js";

/**
 * 31 caracteres: sin 0/O, 1/I/L, para que nadie confunda una letra con un
 * número al copiar el código de la tarjeta impresa.
 * 31^6 = 887.503.681 combinaciones posibles.
 */
export const ALFABETO_CODIGO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const LARGO_CODIGO = 6;

/**
 * Genera un código aleatorio con crypto.getRandomValues (aleatoriedad
 * criptográfica; Math.random() es predecible y NO sirve para secretos).
 *
 * "Rejection sampling": un byte va de 0 a 255. Si hiciéramos byte % 31, los
 * valores 248..255 caerían en los primeros 8 caracteres del alfabeto, que
 * saldrían un poco más seguido que el resto (sesgo de módulo). Por eso
 * descartamos los bytes >= 248 (el múltiplo de 31 más grande que entra en 256)
 * y pedimos otros.
 */
export function generarCodigo() {
  const base = ALFABETO_CODIGO.length;
  const limite = 256 - (256 % base); // 248
  const caracteres = [];
  const bytes = new Uint8Array(16);

  while (caracteres.length < LARGO_CODIGO) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < limite && caracteres.length < LARGO_CODIGO) {
        caracteres.push(ALFABETO_CODIGO[byte % base]);
      }
    }
  }
  return caracteres.join("");
}

/**
 * Lo que escribe la persona: acepta minúsculas, espacios y guiones
 * ("abc-def" → "ABCDEF"). Devuelve null si no tiene el formato correcto.
 * Esto NO es "corregir" la entrada: el alfabeto es justamente insensible a
 * mayúsculas y los separadores son decorativos en la tarjeta impresa.
 */
export function normalizarCodigo(texto) {
  if (typeof texto !== "string") return null;
  const limpio = texto.toUpperCase().replace(/[\s-]/g, "");
  if (limpio.length !== LARGO_CODIGO) return null;
  for (const caracter of limpio) {
    if (!ALFABETO_CODIGO.includes(caracter)) return null;
  }
  return limpio;
}

/** Sal aleatoria de 16 bytes, en hexadecimal. Una distinta por placa. */
export function generarSal() {
  return bytesAHex(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * SHA-256 de "sal:código". La sal hace que dos placas con el mismo código
 * tengan hashes distintos y que no sirva una tabla precalculada de hashes.
 */
export async function hashearCodigo(codigo, salHex) {
  return bytesAHex(await sha256(`${salHex}:${codigo}`));
}

/** Compara el código ingresado contra el hash guardado, en tiempo constante. */
export async function verificarCodigo(codigo, salHex, hashGuardadoHex) {
  const calculado = await sha256(`${salHex}:${codigo}`);
  return compararEnTiempoConstante(calculado, hexABytes(hashGuardadoHex));
}
