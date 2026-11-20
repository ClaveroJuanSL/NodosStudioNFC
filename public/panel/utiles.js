// utiles.js — Funciones puras del panel (sin DOM ni red), para poder probarlas
// con node:test. Ver test/panel.test.js.

/**
 * Lee un precio escrito "a la argentina": "6500", "14500,50", "14.500,50".
 * Devuelve un número o null si no es válido. La base lo vuelve a validar.
 *   "6.500"  → 6500   (punto de miles)
 *   "6.50"   → 6.5    (punto decimal)
 */
export function leerPrecio(texto) {
  const limpio = String(texto).trim().replace(/\s/g, "").replace(/^\$/, "");
  let normal;
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(limpio)) normal = limpio.replace(/\./g, "").replace(",", ".");
  else if (/^\d+([.,]\d{1,2})?$/.test(limpio)) normal = limpio.replace(",", ".");
  else return null;
  const numero = Number(normal);
  return Number.isFinite(numero) && numero >= 0 && numero <= 99999999.99 ? numero : null;
}

/** Entero entre 0 y 9999. Vacío → el valor por defecto. Inválido → null. */
export function leerOrden(texto, porDefecto) {
  if (String(texto).trim() === "") return porDefecto;
  const numero = Number(texto);
  return Number.isInteger(numero) && numero >= 0 && numero <= 9999 ? numero : null;
}

// ─── Fotos ───────────────────────────────────────────────────────

export const BUCKET_FOTOS = "menu";
export const LADO_MAXIMO_FOTO = 1000; // px del lado más largo
export const PESO_MAXIMO_FOTO = 500 * 1024; // un poco menos que el límite del bucket (512 KB)
export const PESO_MAXIMO_ORIGINAL = 20 * 1024 * 1024; // lo que aceptamos ANTES de comprimir

/**
 * Tamaño al que hay que achicar una imagen para que su lado más largo no pase
 * de `maximo`, manteniendo la proporción. Nunca agranda. null si no es válido.
 */
export function calcularTamano(ancho, alto, maximo = LADO_MAXIMO_FOTO) {
  if (![ancho, alto, maximo].every((n) => Number.isFinite(n) && n > 0)) return null;
  const escala = Math.min(1, maximo / Math.max(ancho, alto));
  return { ancho: Math.max(1, Math.round(ancho * escala)), alto: Math.max(1, Math.round(alto * escala)) };
}

const EXTENSIONES = { "image/webp": "webp", "image/jpeg": "jpg" };

/** Ruta de una foto nueva: <id-del-local>/<uuid>.webp (la carpeta es lo que mira RLS). */
export function rutaDeFoto(restauranteId, tipo, uuid) {
  const extension = EXTENSIONES[tipo];
  if (!extension) return null;
  return `${restauranteId}/${uuid}.${extension}`;
}

/**
 * Dada la URL pública guardada en la base, devuelve la ruta dentro del bucket
 * (para poder borrarla), o null si la URL no es de NUESTRO Storage.
 */
export function rutaDesdeUrl(url, origenSupabase) {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    const prefijo = `/storage/v1/object/public/${BUCKET_FOTOS}/`;
    if (u.origin !== origenSupabase || !u.pathname.startsWith(prefijo)) return null;
    const ruta = decodeURIComponent(u.pathname.slice(prefijo.length));
    return ruta && !ruta.includes("..") ? ruta : null;
  } catch {
    return null;
  }
}

/** 14500.5 → "$ 14.500,50"; 6500 → "$ 6.500". */
export function mostrarPrecio(valor) {
  const numero = Number(valor);
  if (!Number.isFinite(numero)) return "";
  return `$ ${new Intl.NumberFormat("es-AR", {
    minimumFractionDigits: Number.isInteger(numero) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(numero)}`;
}
