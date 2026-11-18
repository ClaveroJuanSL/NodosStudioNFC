// ─────────────────────────────────────────────────────────────────
// menu.js — GET /m/<slug>: el menú digital público de un cliente.
//
// Flujo:
//   1. Validar el slug con regex (antes de tocar nada).
//   2. ¿Está en la caché de Cloudflare? → responder desde ahí (rápido, gratis).
//   3. Si no: pedirle los datos a Supabase (API REST, con la publishable key).
//   4. Armar el HTML, guardarlo en la caché unos minutos y responder.
//
// Los datos se leen EN CADA VISITA (con caché corta), no en el build: cambiar
// un precio en el panel se ve en pocos minutos, sin redeploy.
// ─────────────────────────────────────────────────────────────────

import { hashParaCsp, renderizarMenu } from "../lib/menu.js";
import { ErrorHttp, paginaNoEncontrada } from "../lib/respuestas.js";
import { esSlugValido, leerDominiosPermitidos } from "../lib/validacion.js";

const TIEMPO_MAXIMO_SUPABASE_MS = 4000;

// Navegador: 1 min. Caché de Cloudflare: 2 min. Un menú que cambia poco no
// necesita más, y un cliente que cambia un precio no espera mucho.
const CACHE_MENU = "public, max-age=60, s-maxage=120";
// Los 404 también se cachean (menos tiempo): así alguien que pruebe miles de
// slugs inventados no nos hace gastar la cuota de Supabase.
const CACHE_NO_ENCONTRADO = "public, max-age=30, s-maxage=60";

/**
 * Lee y valida la configuración. Si falta, el servicio "no está disponible"
 * (503) en vez de romper con un error raro.
 */
function leerConfiguracion(env) {
  try {
    const origen = new URL(env.SUPABASE_URL).origin;
    const clave = env.SUPABASE_PUBLISHABLE_KEY;
    if (!origen.startsWith("https://") || typeof clave !== "string" || clave.length < 10) throw new Error();
    return { origen, clave };
  } catch {
    console.error("Falta configurar SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY");
    throw new ErrorHttp(503, "servicio_no_disponible");
  }
}

/**
 * Pide a Supabase el restaurante con sus categorías y productos en UNA sola
 * consulta (PostgREST permite "embeber" tablas relacionadas en el select).
 * Devuelve el objeto, o null si no existe / está inactivo.
 *
 * La clave publishable va en el header `apikey`. NO se manda como
 * "Authorization: Bearer": las claves nuevas no son JWT. Las políticas RLS
 * deciden qué filas devuelve (solo restaurantes activos).
 */
async function pedirRestaurante({ origen, clave }, slug) {
  const url = new URL("/rest/v1/restaurantes", origen);
  url.searchParams.set("slug", `eq.${slug}`); // el slug ya pasó la regex
  url.searchParams.set("activo", "eq.true");
  url.searchParams.set(
    "select",
    "nombre,logo_url,color,resena_url,instagram,whatsapp," +
      "categorias(id,nombre,orden,productos(id,nombre,descripcion,precio,foto_url,disponible,orden))",
  );
  url.searchParams.set("limit", "1");

  let respuesta;
  try {
    respuesta = await fetch(url, {
      headers: { apikey: clave, Accept: "application/json" },
      signal: AbortSignal.timeout(TIEMPO_MAXIMO_SUPABASE_MS),
    });
  } catch (error) {
    console.error("No se pudo consultar Supabase:", error?.message ?? error);
    throw new ErrorHttp(503, "servicio_no_disponible");
  }

  if (!respuesta.ok) {
    console.error(`Supabase respondió ${respuesta.status} para el slug ${slug}`);
    throw new ErrorHttp(503, "servicio_no_disponible");
  }

  const filas = await respuesta.json();
  return Array.isArray(filas) && filas.length > 0 ? filas[0] : null;
}

/** Para HEAD: mismos headers, sin cuerpo. */
function sinCuerpoSiEsHead(request, respuesta) {
  return request.method === "HEAD" ? new Response(null, respuesta) : respuesta;
}

export async function manejarMenu(request, env, [slug]) {
  if (!esSlugValido(slug)) return paginaNoEncontrada(request, env);

  // Clave de caché: solo el path. Así "?x=123" no sirve para saltear la caché.
  const cache = globalThis.caches?.default;
  const claveCache = new Request(new URL(`/m/${slug}`, request.url).href, { method: "GET" });
  if (cache) {
    const guardada = await cache.match(claveCache);
    if (guardada) return sinCuerpoSiEsHead(request, guardada);
  }

  const config = leerConfiguracion(env);
  const restaurante = await pedirRestaurante(config, slug);

  let respuesta;
  if (!restaurante) {
    const noEncontrada = await paginaNoEncontrada(request, env);
    respuesta = new Response(noEncontrada.body, {
      status: 404,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": CACHE_NO_ENCONTRADO },
    });
  } else {
    const { html, estilo } = renderizarMenu(restaurante, {
      origen: config.origen,
      dominios: leerDominiosPermitidos(env.DOMINIOS_PERMITIDOS),
    });
    respuesta = new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": CACHE_MENU,
        // CSP propia de esta página (más estricta que "puede todo lo del sitio"
        // en lo que importa): sin scripts, e imágenes solo del Storage de
        // nuestro Supabase. El <style> inline del color se autoriza por su hash.
        "Content-Security-Policy":
          `default-src 'none'; style-src 'self' ${await hashParaCsp(estilo)}; ` +
          `img-src 'self' ${config.origen}; script-src 'none'; connect-src 'none'; ` +
          "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      },
    });
  }

  if (cache) await cache.put(claveCache, respuesta.clone());
  return sinCuerpoSiEsHead(request, respuesta);
}
