// ─────────────────────────────────────────────────────────────────
// placas.js — Lo que hace el DUEÑO DEL NEGOCIO con su placa.
//
//   GET  /e/<id>                    → página para cambiar el destino
//   POST /api/placas/<id>/activar   → primer uso: código + link de Google
//   PUT  /api/placas/<id>/destino   → cambiar el link (también con código)
//
// No hay usuario ni contraseña: el "permiso" es conocer el código de 6
// caracteres de la tarjeta. Por eso el límite de intentos es crítico.
// ─────────────────────────────────────────────────────────────────

import { ESTADOS, actualizarEnlace, obtenerEnlace } from "../lib/almacen.js";
import { normalizarCodigo, verificarCodigo } from "../lib/codigos.js";
import { ErrorHttp, json, paginaNoEncontrada, servirPagina } from "../lib/respuestas.js";
import { ipDelCliente, verificarOrigen } from "../lib/seguridad.js";
import { esIdDePlaca, exigirDestino, leerDominiosPermitidos, leerJson } from "../lib/validacion.js";
import { LIMITES, exigirIntento, reiniciarIntentos } from "../limitador.js";

// ─── Página de edición ───────────────────────────────────────────

export async function manejarPaginaEdicion(request, env, [id]) {
  if (!esIdDePlaca(id)) return paginaNoEncontrada(request, env);
  const registro = await obtenerEnlace(env, id);
  // Solo placas activas y con código. Una sin activar se activa en /r/<id>.
  if (registro?.estado !== ESTADOS.ACTIVA || !registro.codigo_hash) {
    return paginaNoEncontrada(request, env);
  }
  return servirPagina(request, env, "/editar", 200);
}

// ─── API ─────────────────────────────────────────────────────────

export async function manejarActivacion(request, env, [id]) {
  const { registro, destino } = await validarSolicitudConCodigo(request, env, id, ESTADOS.SIN_ACTIVAR);
  await actualizarEnlace(env, id, registro, { estado: ESTADOS.ACTIVA, destino });
  return json({ ok: true, id, destino });
}

export async function manejarCambioDeDestino(request, env, [id]) {
  const { registro, destino } = await validarSolicitudConCodigo(request, env, id, ESTADOS.ACTIVA);
  await actualizarEnlace(env, id, registro, { destino });
  return json({ ok: true, id, destino });
}

/**
 * Pasos comunes a activar y editar. El ORDEN importa:
 *   1. CSRF y formato (barato, sin tocar nada).
 *   2. Límite por IP (antes de leer KV, así un ataque no nos cuesta lecturas).
 *   3. Estado de la placa.
 *   4. Límite por placa: se RESERVA el intento ANTES de comparar el código.
 *      Si primero comparáramos y después sumáramos el fallo, 50 requests en
 *      paralelo podrían comparar antes de que se registre el primer fallo.
 *   5. Comparación del código. Si es correcto, se libera el contador.
 */
async function validarSolicitudConCodigo(request, env, id, estadoRequerido) {
  verificarOrigen(request);
  if (!esIdDePlaca(id)) throw new ErrorHttp(404, "placa_no_disponible");

  const datos = await leerJson(request, ["codigo", "destino"]);
  const codigo = normalizarCodigo(datos.codigo);
  if (!codigo) throw new ErrorHttp(400, "codigo_formato");
  const destino = exigirDestino(datos.destino, leerDominiosPermitidos(env.DOMINIOS_PERMITIDOS));

  const { limite: limiteIp, ventanaSeg: ventanaIp } = LIMITES.PLACA_POR_IP;
  await exigirIntento(env, `ip-placas:${ipDelCliente(request)}`, limiteIp, ventanaIp);

  const registro = await obtenerEnlace(env, id);
  if (!registro || !registro.codigo_hash) throw new ErrorHttp(404, "placa_no_disponible");
  if (registro.estado !== estadoRequerido) {
    const yaActiva = estadoRequerido === ESTADOS.SIN_ACTIVAR && registro.estado === ESTADOS.ACTIVA;
    throw new ErrorHttp(yaActiva ? 409 : 404, yaActiva ? "placa_ya_activada" : "placa_no_disponible");
  }

  const claveIntentos = `placa:${id}`;
  const { limite, ventanaSeg } = LIMITES.PLACA_POR_ID;
  const restantes = await exigirIntento(env, claveIntentos, limite, ventanaSeg);

  const correcto = await verificarCodigo(codigo, registro.sal, registro.codigo_hash);
  if (!correcto) throw new ErrorHttp(403, "codigo_incorrecto", { intentosRestantes: restantes });

  await reiniciarIntentos(env, claveIntentos);
  return { registro, destino };
}
