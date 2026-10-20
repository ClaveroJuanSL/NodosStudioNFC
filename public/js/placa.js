// ─────────────────────────────────────────────────────────────────
// placa.js — Formularios de activar.html y editar.html.
//
// Las dos páginas son casi iguales; cambia a qué endpoint se manda:
//   activar → POST /api/placas/<id>/activar
//   editar  → PUT  /api/placas/<id>/destino
//
// El ID de la placa sale de la URL (/r/nds-00001 o /e/nds-00001), que el
// Worker ya validó antes de servir esta página. Igual lo volvemos a
// validar acá: nunca confiamos en que "seguro viene bien".
// ─────────────────────────────────────────────────────────────────

const REGEX_RUTA = /^\/(r|e)\/(nds-\d{5,})$/;

const pagina = document.body.dataset.pagina; // "activar" | "editar"
const formulario = document.querySelector("[data-formulario-placa]");
const estado = document.querySelector("[data-estado]");
const exito = document.querySelector("[data-exito]");
const boton = formulario.querySelector('button[type="submit"]');

function mostrarMensaje(texto, esError = false) {
  // textContent (y no innerHTML): el texto se muestra tal cual, nunca se
  // interpreta como HTML. Así un mensaje con "<script>" no se ejecuta.
  estado.textContent = texto;
  estado.classList.toggle("es-error", esError);
}

const coincidencia = window.location.pathname.match(REGEX_RUTA);

if (!coincidencia) {
  formulario.hidden = true;
  estado.textContent = "";
  const aviso = document.createElement("p");
  aviso.className = "estado-mensaje es-error";
  aviso.textContent = "Abrí esta página escaneando o tocando tu placa.";
  formulario.after(aviso);
} else {
  const id = coincidencia[2];
  for (const elemento of document.querySelectorAll("[data-id-placa]")) elemento.textContent = id;

  const endpoint =
    pagina === "activar"
      ? { metodo: "POST", url: `/api/placas/${id}/activar` }
      : { metodo: "PUT", url: `/api/placas/${id}/destino` };

  formulario.addEventListener("submit", async (evento) => {
    evento.preventDefault();

    const codigo = formulario.elements.codigo.value.trim();
    const destino = formulario.elements.destino.value.trim();
    if (!codigo || !destino) {
      mostrarMensaje("Completá el código y el link.", true);
      (codigo ? formulario.elements.destino : formulario.elements.codigo).focus();
      return;
    }

    boton.disabled = true;
    mostrarMensaje("Guardando…");

    try {
      const respuesta = await fetch(endpoint.url, {
        method: endpoint.metodo,
        // Content-Type JSON: el Worker lo exige (también es parte de la
        // defensa CSRF). El navegador agrega solo el header Origin.
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo, destino }),
      });
      const datos = await respuesta.json().catch(() => ({}));

      if (respuesta.ok) {
        mostrarExito(id);
        return;
      }

      let mensaje = datos.mensaje ?? "No se pudo guardar. Probá de nuevo.";
      if (typeof datos.intentosRestantes === "number") {
        mensaje += ` Te quedan ${datos.intentosRestantes} intento(s) en esta hora.`;
      }
      mostrarMensaje(mensaje, true);
    } catch {
      mostrarMensaje("No pudimos conectarnos. Revisá tu conexión a internet.", true);
    } finally {
      boton.disabled = false;
    }
  });
}

function mostrarExito(id) {
  formulario.hidden = true;
  exito.hidden = false;

  const probar = exito.querySelector("[data-enlace-probar]");
  const editar = exito.querySelector("[data-enlace-editar]");
  if (probar) probar.href = `/r/${id}`;
  if (editar) editar.href = `/e/${id}`;

  // Movemos el foco al título del mensaje de éxito: quien usa lector de
  // pantalla se entera del cambio sin tener que buscarlo.
  exito.querySelector("h2").focus();
}
