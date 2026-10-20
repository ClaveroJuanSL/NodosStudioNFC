// ─────────────────────────────────────────────────────────────────
// respuestas.js — Cómo responde el Worker.
//
// Centraliza tres cosas para que ninguna ruta las "olvide":
//   1. Los headers de seguridad (los mismos que public/_headers).
//   2. El formato de los errores: un código + un mensaje genérico.
//   3. Cómo servir una página HTML de public/ con otro status (ej. 404).
// ─────────────────────────────────────────────────────────────────

// IMPORTANTE: public/_headers solo se aplica a los archivos estáticos que
// Cloudflare sirve directo. Las respuestas que arma el Worker (302, API, 404)
// NO pasan por ese archivo, así que acá repetimos los mismos headers.
// El test test/headers.test.js falla si los dos lugares no coinciden.
export const HEADERS_DE_SEGURIDAD = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; " +
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "X-Frame-Options": "DENY",
});

// Mensajes que ve el usuario. Son deliberadamente genéricos: nunca incluyen
// stack traces, nombres de claves de KV ni detalles de la configuración.
const MENSAJES = Object.freeze({
  solicitud_invalida: "La solicitud no es válida.",
  json_invalido: "El formato de los datos no es válido.",
  tipo_contenido: "La solicitud tiene que enviarse como JSON.",
  cuerpo_muy_grande: "La solicitud es demasiado grande.",
  campos_desconocidos: "La solicitud tiene campos que no se esperaban.",
  origen_no_permitido: "Solicitud rechazada.",
  no_autorizado: "No autorizado.",
  no_encontrado: "No encontrado.",
  metodo_no_permitido: "Método no permitido.",
  demasiados_intentos: "Demasiados intentos. Probá de nuevo más tarde.",
  slug_invalido: "El slug solo puede tener minúsculas, números y guiones (máximo 40).",
  slug_reservado: "Los slugs que empiezan con «nds-» están reservados para placas.",
  slug_existente: "Ya existe un enlace con ese slug.",
  destino_invalido: "El destino tiene que ser un link https:// de Google (reseñas o Maps).",
  cliente_invalido: "El nombre del cliente no es válido (máximo 80 caracteres).",
  estado_invalido: "El estado tiene que ser «activa» o «desactivada».",
  falta_destino: "Para activar un enlace primero tiene que tener un destino.",
  sin_cambios: "No se envió ningún cambio.",
  codigo_formato: "El código tiene 6 caracteres (letras y números).",
  codigo_incorrecto: "El código no es correcto.",
  placa_no_disponible: "Esta placa no está disponible.",
  placa_ya_activada: "Esta placa ya fue activada. Para cambiar el destino usá la página de edición.",
  servicio_no_disponible: "El servicio no está disponible en este momento.",
  error_interno: "Ocurrió un error. Probá de nuevo más tarde.",
});

/**
 * Error "esperado": algo que el cliente hizo mal (datos inválidos, sin
 * permiso, etc.). Las rutas lo lanzan con `throw` y src/index.js lo convierte
 * en una respuesta JSON. Así no hay que repetir try/catch en cada ruta.
 */
export class ErrorHttp extends Error {
  constructor(status, codigo, extra = {}) {
    super(codigo);
    this.status = status;
    this.codigo = codigo;
    this.extra = extra;
  }
}

/** Respuesta JSON estándar. */
export function json(datos, status = 200, headersExtra = {}) {
  return new Response(JSON.stringify(datos), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headersExtra },
  });
}

/** Respuesta de error JSON: { error: "codigo", mensaje: "texto para el usuario" }. */
export function errorJson(status, codigo, extra = {}) {
  const headers = {};
  // 429: le decimos al cliente cuántos segundos esperar (header estándar).
  if (status === 429 && extra.reintentarEnSeg) headers["Retry-After"] = String(extra.reintentarEnSeg);
  return json(
    { error: codigo, mensaje: MENSAJES[codigo] ?? MENSAJES.error_interno, ...extra },
    status,
    headers,
  );
}

/**
 * Devuelve una página de public/ con el status que elijamos.
 * Ej.: la placa sin activar muestra /activar con status 200 en la URL /r/<id>.
 *
 * Pedimos "/activar" y no "/activar.html" porque Cloudflare normaliza las
 * URLs de HTML: /activar.html redirige a /activar.
 */
export async function servirPagina(request, env, ruta, status = 200) {
  const urlPagina = new URL(ruta, request.url);
  const archivo = await env.ASSETS.fetch(new Request(urlPagina, { method: "GET" }));
  return new Response(request.method === "HEAD" ? null : archivo.body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** 404 en HTML para las rutas que ve una persona (no la API). */
export function paginaNoEncontrada(request, env) {
  return servirPagina(request, env, "/404", 404);
}

/**
 * Agrega los headers de seguridad a CUALQUIER respuesta que salga del Worker.
 * Si una ruta ya puso un header (ej. Referrer-Policy: no-referrer en el
 * redirect), se respeta el de la ruta.
 */
export function conHeadersDeSeguridad(respuesta) {
  // Algunas respuestas (las de env.ASSETS.fetch, por ejemplo) tienen headers
  // inmutables: copiamos la respuesta para poder modificarlos.
  const copia = new Response(respuesta.body, respuesta);
  for (const [nombre, valor] of Object.entries(HEADERS_DE_SEGURIDAD)) {
    if (!copia.headers.has(nombre)) copia.headers.set(nombre, valor);
  }
  // Todo lo dinámico es "no-store": ni el navegador ni un proxy lo guardan.
  if (!copia.headers.has("Cache-Control")) copia.headers.set("Cache-Control", "no-store");
  return copia;
}
