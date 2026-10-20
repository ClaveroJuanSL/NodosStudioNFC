// ─────────────────────────────────────────────────────────────────
// validacion.js — Todo lo que entra desde afuera pasa por acá.
//
// Principio: "validar, no corregir". Si algo no cumple el formato, se
// rechaza; no intentamos adivinar qué quiso decir el usuario (por ejemplo,
// NO pasamos el slug a minúsculas). Corregir entradas es una fuente clásica
// de bugs de seguridad, porque dos textos distintos terminan siendo "lo mismo".
// ─────────────────────────────────────────────────────────────────

import { ErrorHttp } from "./respuestas.js";

/** Formato de cualquier slug (lo que va después de /r/). */
export const REGEX_SLUG = /^[a-z0-9-]{1,40}$/;

/** Las placas pregeneradas usan IDs tipo nds-00001. */
export const PREFIJO_PLACA = "nds-";
export const REGEX_ID_PLACA = /^nds-\d{5,}$/;

export const LARGO_MAXIMO_DESTINO = 500;
export const LARGO_MAXIMO_CLIENTE = 80;
export const TAMANO_MAXIMO_CUERPO = 10 * 1024; // 10 KB alcanzan y sobran

/**
 * En google.com y www.google.com cualquiera puede armar URLs "raras", por
 * ejemplo el redirector de Google (/url?q=https://sitio-malo). Por eso en
 * esos dos hosts solo aceptamos rutas de Maps y de búsqueda (donde viven los
 * links de reseñas). Los demás hosts de la allowlist son de uso exclusivo
 * de Google Maps / reseñas, así que no necesitan regla de ruta.
 */
const RUTAS_PERMITIDAS_POR_HOST = Object.freeze({
  "google.com": ["/maps", "/search"],
  "www.google.com": ["/maps", "/search"],
});

// ─── Slugs ───────────────────────────────────────────────────────

export function esSlugValido(slug) {
  return typeof slug === "string" && REGEX_SLUG.test(slug);
}

export function esIdDePlaca(slug) {
  return typeof slug === "string" && REGEX_ID_PLACA.test(slug);
}

/** El admin puede crear cualquier slug válido, menos los reservados "nds-". */
export function validarSlugNuevo(slug) {
  if (!esSlugValido(slug)) throw new ErrorHttp(400, "slug_invalido");
  if (slug.startsWith(PREFIJO_PLACA)) throw new ErrorHttp(400, "slug_reservado");
  return slug;
}

// ─── Destinos (a dónde redirige la placa) ────────────────────────

/**
 * Convierte "google.com, g.page" (variable de wrangler.toml) en una lista.
 */
export function leerDominiosPermitidos(texto) {
  return String(texto ?? "")
    .split(",")
    .map((dominio) => dominio.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Valida una URL de destino. Devuelve { ok: true, url } con la URL
 * normalizada, o { ok: false }.
 *
 * Usamos `new URL()` (el parser oficial del estándar WHATWG, el mismo que
 * usa el navegador) en vez de una regex: así evaluamos la URL exactamente
 * como la va a interpretar el celular. Trucos como
 * "https://google.com@sitio-malo.com" o "https://sitio-malo.com\@g.page"
 * quedan expuestos: para el parser, el host real es "sitio-malo.com".
 */
export function validarDestino(valor, dominiosPermitidos) {
  const rechazo = { ok: false };
  if (typeof valor !== "string") return rechazo;

  const texto = valor.trim();
  if (texto.length === 0 || texto.length > LARGO_MAXIMO_DESTINO) return rechazo;

  let url;
  try {
    url = new URL(texto);
  } catch {
    return rechazo; // ni siquiera es una URL
  }

  if (url.protocol !== "https:") return rechazo; // bloquea http:, javascript:, data:...
  if (url.username || url.password) return rechazo; // nada de "usuario@host"
  if (url.port !== "") return rechazo; // solo el puerto estándar 443

  // url.hostname ya viene en minúsculas. Coincidencia EXACTA con la lista:
  // "g.page.sitio-malo.com" o "sites.google.com" no pasan.
  const host = url.hostname;
  if (!dominiosPermitidos.includes(host)) return rechazo;

  const rutas = RUTAS_PERMITIDAS_POR_HOST[host];
  if (rutas && !rutas.some((ruta) => url.pathname === ruta || url.pathname.startsWith(ruta + "/"))) {
    return rechazo;
  }

  // Guardamos la versión normalizada (la que produce el parser).
  if (url.href.length > LARGO_MAXIMO_DESTINO) return rechazo;
  return { ok: true, url: url.href };
}

/** Igual que validarDestino pero lanza un ErrorHttp 400 si no es válido. */
export function exigirDestino(valor, dominiosPermitidos) {
  const resultado = validarDestino(valor, dominiosPermitidos);
  if (!resultado.ok) throw new ErrorHttp(400, "destino_invalido");
  return resultado.url;
}

// ─── Nombre del cliente ──────────────────────────────────────────

/**
 * Texto libre corto. Quitamos caracteres de control (saltos de línea,
 * tabulaciones, etc.) que no tienen sentido en un nombre.
 *
 * Ojo: esto NO es la protección contra XSS. La protección contra XSS está
 * en el lugar donde se MUESTRA el dato (el panel usa textContent).
 */
export function validarCliente(valor) {
  if (valor === undefined || valor === null) return "";
  if (typeof valor !== "string") throw new ErrorHttp(400, "cliente_invalido");
  const limpio = valor.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (limpio.length > LARGO_MAXIMO_CLIENTE) throw new ErrorHttp(400, "cliente_invalido");
  return limpio;
}

// ─── Lectura segura del cuerpo JSON ──────────────────────────────

/**
 * Lee el cuerpo de la request como JSON con cuatro controles:
 *   1. Content-Type: application/json  (también es parte de la defensa CSRF:
 *      un <form> de otro sitio no puede enviar ese tipo sin preflight CORS).
 *   2. Tamaño máximo, cortando la lectura apenas se pasa (no carga 100 MB
 *      en memoria para después rechazarlos).
 *   3. Que sea un objeto { ... } (no un array, un número o null).
 *   4. Que no traiga campos fuera de la lista `camposPermitidos`.
 */
export async function leerJson(request, camposPermitidos) {
  const tipo = request.headers.get("Content-Type") ?? "";
  if (!tipo.toLowerCase().startsWith("application/json")) {
    throw new ErrorHttp(415, "tipo_contenido");
  }

  const texto = await leerCuerpoConLimite(request, TAMANO_MAXIMO_CUERPO);

  let datos;
  try {
    datos = JSON.parse(texto);
  } catch {
    throw new ErrorHttp(400, "json_invalido");
  }

  if (datos === null || typeof datos !== "object" || Array.isArray(datos)) {
    throw new ErrorHttp(400, "json_invalido");
  }

  const desconocidos = Object.keys(datos).filter((campo) => !camposPermitidos.includes(campo));
  if (desconocidos.length > 0) throw new ErrorHttp(400, "campos_desconocidos");

  return datos;
}

async function leerCuerpoConLimite(request, maximoBytes) {
  // Si el cliente declara un tamaño mayor, cortamos sin leer nada.
  const declarado = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declarado) && declarado > maximoBytes) {
    throw new ErrorHttp(413, "cuerpo_muy_grande");
  }
  if (!request.body) return "";

  // Content-Length puede mentir (o faltar): leemos de a pedazos y contamos.
  const lector = request.body.getReader();
  const pedazos = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximoBytes) {
      await lector.cancel();
      throw new ErrorHttp(413, "cuerpo_muy_grande");
    }
    pedazos.push(value);
  }

  const bytes = new Uint8Array(total);
  let posicion = 0;
  for (const pedazo of pedazos) {
    bytes.set(pedazo, posicion);
    posicion += pedazo.byteLength;
  }

  // fatal: true → si los bytes no son UTF-8 válido, error (400) en vez de
  // reemplazarlos en silencio por "�" y guardar un dato corrupto.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ErrorHttp(400, "json_invalido");
  }
}
