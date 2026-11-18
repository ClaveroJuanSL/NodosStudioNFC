// ─────────────────────────────────────────────────────────────────
// menu.js — Convierte los datos de un restaurante en la página HTML del menú.
//
// Son funciones PURAS (sin red ni caché), así se pueden probar con tests.
//
// Regla de oro: los datos vienen de una base que, más adelante, van a editar
// los clientes. Entonces los tratamos como NO confiables:
//   • todo texto se escapa antes de entrar al HTML (anti-XSS),
//   • las URLs se validan (nada de javascript:, nada de hosts ajenos),
//   • el color tiene que ser #rrggbb: es lo único que entra en el <style>.
// ─────────────────────────────────────────────────────────────────

import { validarDestino } from "./validacion.js";

const COLOR_POR_DEFECTO = "#14213d";
const REGEX_COLOR = /^#[0-9a-f]{6}$/i;
const REGEX_INSTAGRAM = /^[A-Za-z0-9._]{1,30}$/;
const REGEX_WHATSAPP = /^\d{8,15}$/;
const PREFIJO_STORAGE = "/storage/v1/object/public/";

/** Escapa los 5 caracteres que permiten "salirse" de un texto o de un atributo HTML. */
export function escapar(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/** Recorta un texto a `max` caracteres. Si no es texto, devuelve "". */
function texto(valor, max) {
  return typeof valor === "string" ? valor.trim().slice(0, max) : "";
}

/** 14500.5 → "$ 14.500,50"; 6500 → "$ 6.500". */
export function formatearPrecio(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero) || numero < 0) return "";
  const formato = new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: Number.isInteger(numero) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `$ ${formato.format(numero)}`;
}

/**
 * Solo aceptamos imágenes alojadas en el Storage PÚBLICO de NUESTRO proyecto de
 * Supabase. Así la CSP puede permitir un único host y nadie puede usar el menú
 * para cargar imágenes de otro lado (rastreo, contenido ajeno).
 */
export function urlDeImagen(valor, origenSupabase) {
  if (typeof valor !== "string" || valor.length > 500) return null;
  try {
    const url = new URL(valor);
    if (url.origin !== origenSupabase) return null;
    if (!url.pathname.startsWith(PREFIJO_STORAGE)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function colorSeguro(valor) {
  return typeof valor === "string" && REGEX_COLOR.test(valor) ? valor.toLowerCase() : COLOR_POR_DEFECTO;
}

/** Elige texto oscuro o blanco, el que dé más contraste sobre el color de marca. */
export function colorSobre(hex) {
  const canales = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminancia = 0.2126 * canales[0] + 0.7152 * canales[1] + 0.0722 * canales[2];
  return luminancia > 0.179 ? "#111827" : "#ffffff";
}

/** Hash SHA-256 en base64: así se identifica un <style> inline en la CSP. */
export async function hashParaCsp(contenido) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contenido));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(bytes)))}'`;
}

function porOrden(a, b) {
  return (Number(a.orden) || 0) - (Number(b.orden) || 0) || String(a.nombre).localeCompare(String(b.nombre), "es");
}

function renderizarProducto(p, origen) {
  const foto = urlDeImagen(p.foto_url, origen);
  const precio = formatearPrecio(p.precio);
  const descripcion = texto(p.descripcion, 300);
  return `<li class="plato${p.disponible === false ? " agotado" : ""}">
  <div class="plato-texto">
    <h3>${escapar(texto(p.nombre, 120))}</h3>${descripcion ? `\n    <p class="descripcion">${escapar(descripcion)}</p>` : ""}
    <p class="precio">${escapar(precio)}${p.disponible === false ? ' <span class="etiqueta">No disponible</span>' : ""}</p>
  </div>${foto ? `\n  <img src="${escapar(foto)}" alt="" width="96" height="96" loading="lazy" decoding="async">` : ""}
</li>`;
}

/**
 * Arma la página.
 * @param {object} restaurante  Fila de `restaurantes` con `categorias(productos)` anidados.
 * @param {{origen: string, dominios: Set<string>|string[]}} opciones
 * @returns {{ html: string, estilo: string }}  `estilo` es el texto EXACTO del <style>
 *   inline; el Worker calcula su hash para la CSP.
 */
export function renderizarMenu(restaurante, { origen, dominios }) {
  const nombre = texto(restaurante.nombre, 80) || "Menú";
  const color = colorSeguro(restaurante.color);
  const estilo = `:root{--color:${color};--sobre-color:${colorSobre(color)}}`;

  const categorias = (Array.isArray(restaurante.categorias) ? restaurante.categorias : [])
    .map((c) => ({
      ...c,
      productos: (Array.isArray(c.productos) ? c.productos : []).filter((p) => texto(p.nombre, 120)).sort(porOrden),
    }))
    .filter((c) => texto(c.nombre, 60) && c.productos.length > 0)
    .sort(porOrden);

  const logo = urlDeImagen(restaurante.logo_url, origen);

  const enlaces = [];
  const resena = typeof restaurante.resena_url === "string" ? validarDestino(restaurante.resena_url, dominios) : { ok: false };
  if (resena.ok) {
    enlaces.push(`<a class="boton principal" href="${escapar(resena.url)}" target="_blank" rel="noopener noreferrer">Dejanos tu reseña</a>`);
  }
  if (REGEX_INSTAGRAM.test(restaurante.instagram ?? "")) {
    enlaces.push(`<a class="boton" href="https://www.instagram.com/${escapar(restaurante.instagram)}/" target="_blank" rel="noopener noreferrer">Instagram</a>`);
  }
  if (REGEX_WHATSAPP.test(restaurante.whatsapp ?? "")) {
    enlaces.push(`<a class="boton" href="https://wa.me/${escapar(restaurante.whatsapp)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>`);
  }

  const cuerpo = categorias.length
    ? categorias
        .map(
          (c, i) => `<section id="c${i + 1}" aria-labelledby="c${i + 1}-t">
  <h2 id="c${i + 1}-t">${escapar(texto(c.nombre, 60))}</h2>
  <ul class="platos">
${c.productos.map((p) => renderizarProducto(p, origen)).join("\n")}
  </ul>
</section>`,
        )
        .join("\n")
    : '<p class="vacio">Estamos preparando el menú. ¡Volvé pronto!</p>';

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapar(nombre)} · Menú</title>
<meta name="description" content="Menú de ${escapar(nombre)}">
<meta name="theme-color" content="${color}">
<link rel="stylesheet" href="/css/menu.css">
<style>${estilo}</style>
</head>
<body>
<header class="cabecera">${logo ? `\n  <img class="logo" src="${escapar(logo)}" alt="" width="72" height="72" decoding="async">` : ""}
  <h1>${escapar(nombre)}</h1>
</header>${categorias.length > 1 ? `
<nav class="categorias" aria-label="Categorías">
${categorias.map((c, i) => `  <a href="#c${i + 1}">${escapar(texto(c.nombre, 60))}</a>`).join("\n")}
</nav>` : ""}
<main>
${cuerpo}
</main>
<p class="creditos">Menú digital por <a href="https://nodosnfc.com.ar/">Nodos Studio</a></p>${enlaces.length ? `
<footer class="barra">
  ${enlaces.join("\n  ")}
</footer>` : ""}
</body>
</html>
`;

  return { html, estilo };
}
