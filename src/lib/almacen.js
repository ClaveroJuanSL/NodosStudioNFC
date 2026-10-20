// ─────────────────────────────────────────────────────────────────
// almacen.js — La ÚNICA parte del código que habla con KV.
//
// Si mañana cambiamos KV por otra base de datos (D1, por ejemplo), solo se
// toca este archivo. Es el patrón "Repository": las rutas piden "dame el
// enlace X" sin saber cómo ni dónde se guarda.
//
// Cada enlace se guarda en la clave "enlace:<slug>" con este registro:
//   {
//     estado:      "sin_activar" | "activa" | "desactivada",
//     destino:     "https://g.page/r/..." | null,
//     cliente:     "Panadería López",
//     codigo_hash: "a3f1..." | null,   ← solo placas pregeneradas
//     sal:         "9c0e..." | null,   ← solo placas pregeneradas
//     creado:      "2026-10-16T21:00:00.000Z",
//     actualizado: "2026-10-16T21:00:00.000Z"
//   }
// ─────────────────────────────────────────────────────────────────

export const PREFIJO_CLAVE = "enlace:";

export const ESTADOS = Object.freeze({
  SIN_ACTIVAR: "sin_activar",
  ACTIVA: "activa",
  DESACTIVADA: "desactivada",
});

// ─── Construcción de registros ───────────────────────────────────

/** Enlace creado desde el admin: nace activo y sin código. */
export function nuevoEnlace({ destino, cliente }) {
  const ahora = new Date().toISOString();
  return {
    estado: ESTADOS.ACTIVA,
    destino,
    cliente,
    codigo_hash: null,
    sal: null,
    creado: ahora,
    actualizado: ahora,
  };
}

/** Placa pregenerada: nace sin activar, sin destino y con su código hasheado. */
export function nuevaPlaca({ codigo_hash, sal }) {
  const ahora = new Date().toISOString();
  return {
    estado: ESTADOS.SIN_ACTIVAR,
    destino: null,
    cliente: "",
    codigo_hash,
    sal,
    creado: ahora,
    actualizado: ahora,
  };
}

/**
 * La "metadata" de KV es un JSON chico (máx. 1024 bytes) que viaja junto
 * con la clave cuando hacemos list(). Guardamos ahí lo que muestra el panel,
 * así listar 300 enlaces es UNA operación y no 300 lecturas.
 * Nunca ponemos el hash ni la sal: el panel no los necesita.
 */
export function metadataDe(registro) {
  return {
    estado: registro.estado,
    destino: registro.destino,
    cliente: registro.cliente,
    tiene_codigo: Boolean(registro.codigo_hash),
    actualizado: registro.actualizado,
  };
}

// ─── Lectura y escritura ─────────────────────────────────────────

/** Devuelve el registro o null si no existe. */
export async function obtenerEnlace(env, slug) {
  return env.ENLACES.get(PREFIJO_CLAVE + slug, { type: "json" });
}

export async function guardarEnlace(env, slug, registro) {
  await env.ENLACES.put(PREFIJO_CLAVE + slug, JSON.stringify(registro), {
    metadata: metadataDe(registro),
  });
}

/** Aplica cambios a un registro existente y actualiza la fecha. */
export async function actualizarEnlace(env, slug, registro, cambios) {
  const actualizado = { ...registro, ...cambios, actualizado: new Date().toISOString() };
  await guardarEnlace(env, slug, actualizado);
  return actualizado;
}

/**
 * Lista todos los enlaces usando solo la metadata.
 * KV devuelve hasta 1000 claves por página; si hay más, trae un "cursor"
 * para pedir la siguiente página.
 */
export async function listarEnlaces(env) {
  const enlaces = [];
  let cursor;
  do {
    const pagina = await env.ENLACES.list({ prefix: PREFIJO_CLAVE, cursor });
    for (const clave of pagina.keys) {
      enlaces.push({ slug: clave.name.slice(PREFIJO_CLAVE.length), ...(clave.metadata ?? {}) });
    }
    cursor = pagina.list_complete ? undefined : pagina.cursor;
  } while (cursor);
  return enlaces;
}

/** Lo que devolvemos al panel: el registro SIN hash ni sal. */
export function vistaPublica(slug, registro) {
  return { slug, ...metadataDe(registro), creado: registro.creado };
}
