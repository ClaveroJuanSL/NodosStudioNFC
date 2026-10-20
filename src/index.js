// ─────────────────────────────────────────────────────────────────
// index.js — Punto de entrada del Worker.
//
// Cloudflare llama a `fetch()` por cada request que NO corresponde a un
// archivo de public/. Acá hacemos tres cosas:
//   1. Elegir qué función maneja la ruta (el "router").
//   2. Convertir los errores en respuestas, sin filtrar detalles internos.
//   3. Agregar los headers de seguridad a TODA respuesta.
// ─────────────────────────────────────────────────────────────────

import { ErrorHttp, conHeadersDeSeguridad, errorJson, paginaNoEncontrada } from "./lib/respuestas.js";
import * as admin from "./rutas/admin.js";
import { manejarActivacion, manejarCambioDeDestino, manejarPaginaEdicion } from "./rutas/placas.js";
import { manejarRedireccion } from "./rutas/redirector.js";

// Cloudflare necesita que la clase del Durable Object se exporte desde acá.
export { Limitador } from "./limitador.js";

/**
 * Tabla de rutas. Cada patrón es una regex sobre el pathname completo
 * (con ^ y $), así "/r/abc/extra" o "/r/" no coinciden por accidente.
 * Lo que captura cada grupo ( ) llega al manejador como array de parámetros.
 */
const RUTAS = [
  { patron: /^\/r\/([^/]+)$/, metodos: { GET: manejarRedireccion, HEAD: manejarRedireccion } },
  { patron: /^\/e\/([^/]+)$/, metodos: { GET: manejarPaginaEdicion, HEAD: manejarPaginaEdicion } },
  { patron: /^\/api\/placas\/([^/]+)\/activar$/, metodos: { POST: manejarActivacion } },
  { patron: /^\/api\/placas\/([^/]+)\/destino$/, metodos: { PUT: manejarCambioDeDestino } },
  { patron: /^\/api\/admin\/enlaces$/, metodos: { GET: admin.listar, POST: admin.crear } },
  { patron: /^\/api\/admin\/enlaces\/([^/]+)$/, metodos: { PUT: admin.editar, DELETE: admin.desactivar } },
];

async function enrutar(request, env) {
  const { pathname } = new URL(request.url);

  for (const ruta of RUTAS) {
    const coincidencia = pathname.match(ruta.patron);
    if (!coincidencia) continue;

    const manejador = ruta.metodos[request.method];
    if (!manejador) {
      // La ruta existe pero no con ese método → 405 + qué métodos sí acepta.
      const respuesta = errorJson(405, "metodo_no_permitido");
      respuesta.headers.set("Allow", Object.keys(ruta.metodos).join(", "));
      return respuesta;
    }
    return manejador(request, env, coincidencia.slice(1));
  }

  if (pathname.startsWith("/api/")) throw new ErrorHttp(404, "no_encontrado");
  return paginaNoEncontrada(request, env);
}

export default {
  async fetch(request, env) {
    let respuesta;
    try {
      respuesta = await enrutar(request, env);
    } catch (error) {
      if (error instanceof ErrorHttp) {
        // Error esperado (validación, permisos, límites): se informa con un
        // código genérico. No hace falta loguearlo.
        respuesta = errorJson(error.status, error.codigo, error.extra);
      } else {
        // Error inesperado: el detalle va SOLO al log (se ve con `npm run logs`).
        // Al cliente le llega un mensaje genérico, sin stack trace.
        console.error("Error no controlado:", error?.stack ?? error);
        respuesta = errorJson(500, "error_interno");
      }
    }
    return conHeadersDeSeguridad(respuesta);
  },
};
