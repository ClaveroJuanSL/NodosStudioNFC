// ─────────────────────────────────────────────────────────────────
// redirector.js — GET /r/<slug>: la URL que va grabada en el chip y en el QR.
//
// Reglas (todas obligatorias):
//   • El slug se valida con regex ANTES de tocar KV.
//   • El destino sale SOLO de KV. Nunca de la URL (?url=..., ?to=...): eso
//     sería un "open redirect" que cualquiera podría usar para phishing con
//     tu dominio de confianza.
//   • Siempre 302 (temporal), nunca 301 (permanente). El navegador guarda los
//     301 sin fecha de vencimiento: si cambiás el destino, ese celular
//     seguiría yendo al viejo para siempre.
//   • Cache-Control: no-store, por el mismo motivo.
// ─────────────────────────────────────────────────────────────────

import { ESTADOS, obtenerEnlace } from "../lib/almacen.js";
import { paginaNoEncontrada, servirPagina } from "../lib/respuestas.js";
import { esSlugValido, leerDominiosPermitidos, validarDestino } from "../lib/validacion.js";

export async function manejarRedireccion(request, env, [slug]) {
  if (!esSlugValido(slug)) return paginaNoEncontrada(request, env);

  const registro = await obtenerEnlace(env, slug);
  if (!registro) return paginaNoEncontrada(request, env);

  if (registro.estado === ESTADOS.ACTIVA) {
    // Defensa en profundidad: volvemos a validar el destino guardado. Si
    // sacaste un dominio de la allowlist, los enlaces viejos dejan de
    // redirigir ahí, aunque estuvieran guardados desde antes.
    const destino = validarDestino(registro.destino, leerDominiosPermitidos(env.DOMINIOS_PERMITIDOS));
    if (!destino.ok) {
      console.error(`Destino guardado fuera de la allowlist para el slug ${slug}`);
      return paginaNoEncontrada(request, env);
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: destino.url,
        "Cache-Control": "no-store",
        // Google no necesita saber desde qué URL llegó el visitante.
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  // Placa nueva: mostramos la página para activarla (con su código).
  if (registro.estado === ESTADOS.SIN_ACTIVAR && registro.codigo_hash) {
    return servirPagina(request, env, "/activar", 200);
  }

  // Desactivada (o cualquier estado inesperado): como si no existiera.
  return paginaNoEncontrada(request, env);
}
