// ─────────────────────────────────────────────────────────────────
// landing.js — JavaScript de la landing. Es "mejora progresiva":
// la página funciona completa sin este archivo; esto solo agrega
// comodidades (el formulario que arma el mensaje de WhatsApp).
// ─────────────────────────────────────────────────────────────────

// Año del pie de página siempre actualizado.
for (const elemento of document.querySelectorAll("[data-anio]")) {
  elemento.textContent = String(new Date().getFullYear());
}

const formulario = document.querySelector("[data-formulario-whatsapp]");

if (formulario) {
  const error = formulario.querySelector("[data-error-whatsapp]");
  formulario.hidden = false; // con JS disponible, mostramos el formulario

  formulario.addEventListener("submit", (evento) => {
    // Evitamos el envío "normal" del formulario: no hay servidor que lo
    // reciba. Armamos un link de WhatsApp y lo abrimos.
    evento.preventDefault();
    error.textContent = "";

    const nombre = formulario.elements.nombre.value.trim();
    const negocio = formulario.elements.negocio.value.trim();
    const cantidad = formulario.elements.cantidad.value;

    if (!nombre || !negocio) {
      error.textContent = "Completá tu nombre y el del negocio.";
      (nombre ? formulario.elements.negocio : formulario.elements.nombre).focus();
      return;
    }

    const mensaje =
      `Hola Nodos Studio! Soy ${nombre}, de ${negocio}. ` +
      `Me interesan ${cantidad} placa(s) NFC/QR para reseñas de Google.`;

    // encodeURIComponent convierte espacios, acentos y signos en algo
    // seguro para una URL (ej. "ñ" → "%C3%B1"). Sin esto, un "&" en el
    // nombre del negocio cortaría el mensaje.
    const numero = formulario.dataset.numero;
    const url = `https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}`;

    // Ojo: window.open(url, "_blank", "noopener") devuelve SIEMPRE null, así
    // que no sabríamos si el navegador bloqueó la pestaña. Abrimos normal y
    // cortamos el vínculo a mano: la pestaña nueva no puede controlar esta.
    const ventana = window.open(url, "_blank");
    if (ventana) ventana.opener = null;
    else window.location.href = url; // el navegador bloqueó la pestaña nueva
  });
}
