// ─────────────────────────────────────────────────────────────────
// seguridad.js — Quién puede hacer qué.
//
//   • verificarOrigen       → defensa CSRF (¿la request viene de NUESTRO sitio?)
//   • autenticarAdmin       → Cloudflare Access (JWT) + token secreto
//   • compararEnTiempoConstante → comparar secretos sin filtrar información
//
// No importa nada específico de Cloudflare, así que los tests de Node
// pueden usarlo directamente.
// ─────────────────────────────────────────────────────────────────

import { ErrorHttp } from "./respuestas.js";

const LARGO_MINIMO_TOKEN = 32;

// ─── Utilidades de bytes ─────────────────────────────────────────

export function bytesAHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexABytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
    throw new Error("hex inválido");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export async function sha256(texto) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return new Uint8Array(digest);
}

/**
 * Compara dos secretos tardando SIEMPRE lo mismo.
 *
 * Una comparación común (a === b) corta en el primer carácter distinto: un
 * atacante que mide tiempos con mucha precisión puede ir adivinando el
 * secreto de a un carácter ("timing attack"). Esta versión recorre todos
 * los bytes aunque ya haya encontrado una diferencia.
 *
 * Solo compara arrays del MISMO largo (por eso, antes de comparar tokens,
 * los pasamos por SHA-256: siempre miden 32 bytes y no se filtra el largo).
 */
export function compararEnTiempoConstante(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  // Cloudflare Workers trae una implementación nativa; Node no.
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let diferencia = 0;
  for (let i = 0; i < a.byteLength; i++) diferencia |= a[i] ^ b[i];
  return diferencia === 0;
}

// ─── Datos de la request ─────────────────────────────────────────

/** IP real del visitante (Cloudflare la pone en este header). */
export function ipDelCliente(request) {
  return request.headers.get("CF-Connecting-IP") ?? "desconocida";
}

/**
 * ¿Estamos en `wrangler dev` en la PC del desarrollador?
 * Exigimos las DOS cosas: la variable ENTORNO=desarrollo (que solo existe en
 * .dev.vars) Y que se entre por localhost. Si por error esa variable llegara
 * a producción, igual no se saltearía Access porque el host sería el dominio real.
 */
export function esDesarrolloLocal(request, env) {
  const { hostname } = new URL(request.url);
  return env.ENTORNO === "desarrollo" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

// ─── CSRF ────────────────────────────────────────────────────────

/**
 * CSRF ("Cross-Site Request Forgery"): un sitio malicioso hace que TU
 * navegador mande una request a nuestro sitio, aprovechando tus cookies
 * (por ejemplo, la cookie de sesión de Cloudflare Access).
 *
 * Defensa: el navegador SIEMPRE agrega el header Origin en un POST/PUT/DELETE
 * y una página no lo puede falsificar. Si no coincide con nuestro origen, se rechaza.
 */
export function verificarOrigen(request) {
  const origen = request.headers.get("Origin");
  const esperado = new URL(request.url).origin;
  if (!origen || origen !== esperado) throw new ErrorHttp(403, "origen_no_permitido");

  // Capa extra: los navegadores modernos además declaran de dónde salió la
  // request. Si el header existe, tiene que decir "same-origin".
  const sitio = request.headers.get("Sec-Fetch-Site");
  if (sitio && sitio !== "same-origin") throw new ErrorHttp(403, "origen_no_permitido");
}

// ─── Autenticación del admin ─────────────────────────────────────

/**
 * Dos capas independientes. Si una falla o está mal configurada, la otra sigue:
 *   1. Cloudflare Access: verificamos el JWT que Access agrega a cada request.
 *      (En desarrollo local no hay Access, así que se saltea.)
 *   2. Token secreto (ADMIN_TOKEN), que el panel manda en "Authorization: Bearer ...".
 *
 * Si falta configuración, NO se deja pasar: se responde 503. A esto se le
 * llama "fallar cerrado" (fail closed).
 */
export async function autenticarAdmin(request, env) {
  if (!esDesarrolloLocal(request, env)) {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
      console.error("Config incompleta: falta ACCESS_TEAM_DOMAIN o ACCESS_AUD");
      throw new ErrorHttp(503, "servicio_no_disponible");
    }
    const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
    await verificarJwtDeAccess(jwt, {
      equipo: env.ACCESS_TEAM_DOMAIN,
      audiencia: env.ACCESS_AUD,
    });
  }

  await verificarTokenAdmin(request, env);
}

async function verificarTokenAdmin(request, env) {
  const esperado = env.ADMIN_TOKEN;
  if (typeof esperado !== "string" || esperado.length < LARGO_MINIMO_TOKEN) {
    console.error(`Config incompleta: ADMIN_TOKEN falta o tiene menos de ${LARGO_MINIMO_TOKEN} caracteres`);
    throw new ErrorHttp(503, "servicio_no_disponible");
  }

  const encabezado = request.headers.get("Authorization") ?? "";
  const recibido = encabezado.startsWith("Bearer ") ? encabezado.slice("Bearer ".length) : "";

  const iguales = compararEnTiempoConstante(await sha256(recibido), await sha256(esperado));
  if (!iguales) throw new ErrorHttp(401, "no_autorizado");
}

// ─── JWT de Cloudflare Access ────────────────────────────────────
//
// Un JWT son tres partes en base64url separadas por puntos:
//     encabezado.contenido.firma
// Access lo firma con su clave privada (RS256). Nosotros verificamos la firma
// con las claves PÚBLICAS que Access publica en /cdn-cgi/access/certs.
// Sin la clave privada nadie puede fabricar un JWT válido.

const REGEX_EQUIPO_ACCESS = /^[a-z0-9-]+\.cloudflareaccess\.com$/;
const DURACION_CACHE_CLAVES_MS = 60 * 60 * 1000;
let cacheDeClaves = { equipo: null, claves: null, vence: 0 };

async function obtenerClavesDeAccess(equipo) {
  const ahora = Date.now();
  if (cacheDeClaves.equipo === equipo && cacheDeClaves.vence > ahora) return cacheDeClaves.claves;

  const respuesta = await fetch(`https://${equipo}/cdn-cgi/access/certs`);
  if (!respuesta.ok) throw new Error(`No se pudieron obtener las claves de Access (${respuesta.status})`);
  const { keys } = await respuesta.json();
  cacheDeClaves = { equipo, claves: keys, vence: ahora + DURACION_CACHE_CLAVES_MS };
  return keys;
}

function base64UrlABytes(texto) {
  const base64 = texto.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(texto.length / 4) * 4, "=");
  const binario = atob(base64);
  return Uint8Array.from(binario, (caracter) => caracter.charCodeAt(0));
}

function base64UrlAJson(texto) {
  return JSON.parse(new TextDecoder().decode(base64UrlABytes(texto)));
}

/**
 * Verifica firma, emisor, audiencia y vencimiento del JWT.
 * `obtenerClaves` se puede reemplazar en los tests (inyección de dependencias).
 */
export async function verificarJwtDeAccess(jwt, { equipo, audiencia, obtenerClaves = obtenerClavesDeAccess }) {
  const rechazo = () => new ErrorHttp(403, "no_autorizado");

  if (!REGEX_EQUIPO_ACCESS.test(equipo ?? "")) {
    console.error("ACCESS_TEAM_DOMAIN tiene un formato inválido");
    throw new ErrorHttp(503, "servicio_no_disponible");
  }
  if (typeof jwt !== "string") throw rechazo();

  const partes = jwt.split(".");
  if (partes.length !== 3) throw rechazo();
  const [encabezadoB64, contenidoB64, firmaB64] = partes;

  let encabezado, contenido, firma;
  try {
    encabezado = base64UrlAJson(encabezadoB64);
    contenido = base64UrlAJson(contenidoB64);
    firma = base64UrlABytes(firmaB64);
  } catch {
    throw rechazo();
  }

  // Solo aceptamos RS256. Nunca "none" ni algoritmos simétricos: es un ataque
  // clásico a JWT cambiar el algoritmo del encabezado.
  if (encabezado.alg !== "RS256" || typeof encabezado.kid !== "string") throw rechazo();

  const claves = await obtenerClaves(equipo);
  const jwk = claves.find((clave) => clave.kid === encabezado.kid);
  if (!jwk) throw rechazo();

  const clavePublica = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const firmaValida = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    clavePublica,
    firma,
    new TextEncoder().encode(`${encabezadoB64}.${contenidoB64}`),
  );
  if (!firmaValida) throw rechazo();

  // La firma prueba QUIÉN lo emitió; ahora chequeamos PARA QUÉ y HASTA CUÁNDO.
  const ahora = Math.floor(Date.now() / 1000);
  const audiencias = Array.isArray(contenido.aud) ? contenido.aud : [contenido.aud];
  if (contenido.iss !== `https://${equipo}`) throw rechazo();
  if (!audiencias.includes(audiencia)) throw rechazo(); // JWT de OTRA app de Access
  if (typeof contenido.exp !== "number" || contenido.exp < ahora) throw rechazo(); // vencido
  if (typeof contenido.nbf === "number" && contenido.nbf > ahora + 60) throw rechazo(); // todavía no vale

  return contenido;
}
