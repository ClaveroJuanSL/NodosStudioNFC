// ─────────────────────────────────────────────────────────────────
// admin.js — API del panel de administración.
//
//   GET    /api/admin/enlaces          → listar (solo lectura)
//   POST   /api/admin/enlaces          → crear  { slug, destino, cliente }
//   PUT    /api/admin/enlaces/<slug>   → editar { destino?, cliente?, estado? }
//   DELETE /api/admin/enlaces/<slug>   → desactivar (NO borra)
//
// Regla REST que respetamos: GET nunca modifica datos. Todo lo que cambia
// algo usa POST/PUT/DELETE, que además exigen Origin (CSRF) y JSON.
// ─────────────────────────────────────────────────────────────────

import {
  ESTADOS,
  actualizarEnlace,
  guardarEnlace,
  listarEnlaces,
  nuevoEnlace,
  obtenerEnlace,
  vistaPublica,
} from "../lib/almacen.js";
import { ErrorHttp, json } from "../lib/respuestas.js";
import { autenticarAdmin, ipDelCliente, verificarOrigen } from "../lib/seguridad.js";
import {
  esSlugValido,
  exigirDestino,
  leerDominiosPermitidos,
  leerJson,
  validarCliente,
  validarSlugNuevo,
} from "../lib/validacion.js";
import { LIMITES, exigirIntento, reiniciarIntentos } from "../limitador.js";

/**
 * Se ejecuta antes de CADA endpoint del admin.
 * Mismo patrón que en las placas: se reserva un intento de autenticación
 * ANTES de verificar, y se libera si la verificación sale bien.
 */
async function protegerAdmin(request, env, { modifica }) {
  const ip = ipDelCliente(request);
  const { limite, ventanaSeg } = LIMITES.ADMIN_POR_IP;
  await exigirIntento(env, `admin:${ip}`, limite, ventanaSeg);

  if (modifica) verificarOrigen(request);

  const claveFallos = `admin-auth:${ip}`;
  const { limite: limiteAuth, ventanaSeg: ventanaAuth } = LIMITES.ADMIN_TOKEN_POR_IP;
  await exigirIntento(env, claveFallos, limiteAuth, ventanaAuth);
  await autenticarAdmin(request, env); // lanza 401/403/503 si algo no cierra
  await reiniciarIntentos(env, claveFallos);
}

function dominios(env) {
  return leerDominiosPermitidos(env.DOMINIOS_PERMITIDOS);
}

// ─── Endpoints ───────────────────────────────────────────────────

export async function listar(request, env) {
  await protegerAdmin(request, env, { modifica: false });
  const enlaces = await listarEnlaces(env);
  enlaces.sort((a, b) => a.slug.localeCompare(b.slug));
  return json({ enlaces });
}

export async function crear(request, env) {
  await protegerAdmin(request, env, { modifica: true });

  const datos = await leerJson(request, ["slug", "destino", "cliente"]);
  const slug = validarSlugNuevo(datos.slug);
  const destino = exigirDestino(datos.destino, dominios(env));
  const cliente = validarCliente(datos.cliente);

  if (await obtenerEnlace(env, slug)) throw new ErrorHttp(409, "slug_existente");

  const registro = nuevoEnlace({ destino, cliente });
  await guardarEnlace(env, slug, registro);
  return json({ enlace: vistaPublica(slug, registro) }, 201);
}

export async function editar(request, env, [slug]) {
  await protegerAdmin(request, env, { modifica: true });
  const registro = await obtenerRegistroExistente(env, slug);

  const datos = await leerJson(request, ["destino", "cliente", "estado"]);
  const cambios = {};

  if (datos.destino !== undefined) cambios.destino = exigirDestino(datos.destino, dominios(env));
  if (datos.cliente !== undefined) cambios.cliente = validarCliente(datos.cliente);
  if (datos.estado !== undefined) {
    // Desde el admin solo se activa o desactiva. "sin_activar" lo pone el
    // script de lote; volver a ese estado reabriría la activación con código.
    if (![ESTADOS.ACTIVA, ESTADOS.DESACTIVADA].includes(datos.estado)) {
      throw new ErrorHttp(400, "estado_invalido");
    }
    cambios.estado = datos.estado;
  }
  if (Object.keys(cambios).length === 0) throw new ErrorHttp(400, "sin_cambios");

  // Un enlace activo sin destino no tendría a dónde redirigir.
  const destinoFinal = cambios.destino ?? registro.destino;
  if ((cambios.estado ?? registro.estado) === ESTADOS.ACTIVA && !destinoFinal) {
    throw new ErrorHttp(400, "falta_destino");
  }

  const actualizado = await actualizarEnlace(env, slug, registro, cambios);
  return json({ enlace: vistaPublica(slug, actualizado) });
}

/**
 * "Borrar" = desactivar. Un slug que ya está impreso en una placa nunca se
 * reutiliza: si lo borráramos y otro cliente creara el mismo slug, las
 * placas viejas llevarían al negocio equivocado.
 */
export async function desactivar(request, env, [slug]) {
  await protegerAdmin(request, env, { modifica: true });
  const registro = await obtenerRegistroExistente(env, slug);
  const actualizado = await actualizarEnlace(env, slug, registro, { estado: ESTADOS.DESACTIVADA });
  return json({ enlace: vistaPublica(slug, actualizado) });
}

async function obtenerRegistroExistente(env, slug) {
  if (!esSlugValido(slug)) throw new ErrorHttp(404, "no_encontrado");
  const registro = await obtenerEnlace(env, slug);
  if (!registro) throw new ErrorHttp(404, "no_encontrado");
  return registro;
}
