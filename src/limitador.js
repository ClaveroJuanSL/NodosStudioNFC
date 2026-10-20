// ─────────────────────────────────────────────────────────────────
// limitador.js — Rate limiting con un Durable Object.
//
// ¿Por qué no un contador en KV? KV es "eventualmente consistente": si
// llegan 20 intentos a la vez, los 20 pueden leer "0 intentos" antes de que
// se propague el primer incremento, y el límite de 5 no frena nada.
//
// Un Durable Object es un objeto con estado que vive en UN solo lugar del
// mundo. Hay una instancia por nombre (ej. "placa:nds-00001") y Cloudflare
// garantiza que procesa las llamadas de a una: el "leer → sumar → guardar"
// no se puede intercalar con otra request ("input gates").
// ─────────────────────────────────────────────────────────────────

import { DurableObject } from "cloudflare:workers";
import { ErrorHttp } from "./lib/respuestas.js";

export class Limitador extends DurableObject {
  /**
   * Ventana fija: el primer intento abre una ventana de `ventanaSeg`
   * segundos; dentro de esa ventana se permiten `limite` intentos.
   * Devuelve { permitido, restantes, reintentarEnSeg }.
   */
  async consumir(limite, ventanaSeg) {
    const ahora = Date.now();
    let ventana = await this.ctx.storage.get("ventana");

    if (!ventana || ahora >= ventana.reinicio) {
      ventana = { usados: 0, reinicio: ahora + ventanaSeg * 1000 };
      // Cuando termine la ventana, una alarma borra el estado (ver alarm()).
      await this.ctx.storage.setAlarm(ventana.reinicio);
    }

    if (ventana.usados >= limite) {
      return { permitido: false, restantes: 0, reintentarEnSeg: Math.ceil((ventana.reinicio - ahora) / 1000) };
    }

    ventana.usados += 1;
    await this.ctx.storage.put("ventana", ventana);
    return { permitido: true, restantes: limite - ventana.usados, reintentarEnSeg: 0 };
  }

  /** Borra el contador (ej. después de un código correcto). */
  async reiniciar() {
    await this.ctx.storage.deleteAll();
  }

  /** La alarma limpia el almacenamiento: no queda basura de IPs viejas. */
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}

// ─── Funciones que usan las rutas ────────────────────────────────

function instancia(env, clave) {
  // idFromName: el mismo nombre siempre lleva a la misma instancia.
  return env.LIMITADOR.get(env.LIMITADOR.idFromName(clave));
}

/**
 * Consume un intento de la clave. Si no quedan, lanza 429.
 * Devuelve cuántos intentos quedan.
 */
export async function exigirIntento(env, clave, limite, ventanaSeg) {
  const resultado = await instancia(env, clave).consumir(limite, ventanaSeg);
  if (!resultado.permitido) {
    throw new ErrorHttp(429, "demasiados_intentos", { reintentarEnSeg: resultado.reintentarEnSeg });
  }
  return resultado.restantes;
}

export async function reiniciarIntentos(env, clave) {
  await instancia(env, clave).reiniciar();
}

// Límites del sistema, todos en un solo lugar para ajustarlos fácil.
export const LIMITES = Object.freeze({
  // Fallos de código por placa: 5 por hora (requisito).
  PLACA_POR_ID: { limite: 5, ventanaSeg: 60 * 60 },
  // Intentos por IP en las placas: frena a quien prueba muchas placas distintas.
  PLACA_POR_IP: { limite: 30, ventanaSeg: 60 * 60 },
  // Requests al admin por IP.
  ADMIN_POR_IP: { limite: 60, ventanaSeg: 60 },
  // Tokens incorrectos en el admin por IP.
  ADMIN_TOKEN_POR_IP: { limite: 10, ventanaSeg: 15 * 60 },
});
