// ─────────────────────────────────────────────────────────────────
// admin.js — Lógica del panel.
//
// REGLA DE ORO contra XSS: todo dato que viene de la API se muestra con
// textContent o como atributo validado. NUNCA con innerHTML. Si un
// cliente se llamara "<img src=x onerror=alert(1)>", con innerHTML ese
// código se ejecutaría en TU navegador, con TU sesión de admin.
// (La CSP sin scripts inline es la segunda barrera, por si algo se escapa).
// ─────────────────────────────────────────────────────────────────

const API = "/api/admin/enlaces";
const CLAVE_TOKEN = "nodos-admin-token";

const NOMBRES_DE_ESTADO = {
  activa: "Activa",
  sin_activar: "Sin activar",
  desactivada: "Desactivada",
};

// ─── Referencias al DOM ──────────────────────────────────────────
const $ = (selector) => document.querySelector(selector);
const ui = {
  mensaje: $("[data-mensaje]"),
  seccionAcceso: $("[data-seccion-acceso]"),
  seccionPanel: $("[data-seccion-panel]"),
  cerrarSesion: $("[data-cerrar-sesion]"),
  formularioToken: $("[data-formulario-token]"),
  formularioCrear: $("[data-formulario-crear]"),
  filtroTexto: $("[data-filtro-texto]"),
  filtroEstado: $("[data-filtro-estado]"),
  recargar: $("[data-recargar]"),
  resumen: $("[data-resumen]"),
  cuerpoTabla: $("[data-cuerpo-tabla]"),
  vacio: $("[data-vacio]"),
  dialogo: $("[data-dialogo-editar]"),
  formularioEditar: $("[data-formulario-editar]"),
  editarSlug: $("[data-editar-slug]"),
  errorEditar: $("[data-error-editar]"),
  cancelarEdicion: $("[data-cancelar-edicion]"),
};

const estado = {
  token: leerToken(),
  enlaces: [],
  editando: null, // enlace que está abierto en el diálogo
};

// ─── Token (sessionStorage) ──────────────────────────────────────
// sessionStorage vive solo mientras la pestaña está abierta: es un
// término medio entre "pedirlo en cada recarga" y "guardarlo para siempre".
// El try/catch es porque algunos navegadores en modo privado lo bloquean.

function leerToken() {
  try {
    return sessionStorage.getItem(CLAVE_TOKEN) ?? "";
  } catch {
    return "";
  }
}

function guardarToken(token) {
  estado.token = token;
  try {
    if (token) sessionStorage.setItem(CLAVE_TOKEN, token);
    else sessionStorage.removeItem(CLAVE_TOKEN);
  } catch {
    /* sin almacenamiento: el token queda solo en memoria */
  }
}

// ─── Comunicación con la API ─────────────────────────────────────

class ErrorApi extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

async function llamarApi(metodo, ruta, cuerpo) {
  const opciones = {
    method: metodo,
    headers: { Authorization: `Bearer ${estado.token}` },
    // Si la sesión de Access venció, Access responde con una redirección a
    // su pantalla de login. "manual" nos deja detectarlo en vez de fallar raro.
    redirect: "manual",
  };
  if (cuerpo !== undefined) {
    opciones.headers["Content-Type"] = "application/json";
    opciones.body = JSON.stringify(cuerpo);
  }

  let respuesta;
  try {
    respuesta = await fetch(ruta, opciones);
  } catch {
    throw new ErrorApi(0, "No se pudo conectar con el servidor.");
  }
  if (respuesta.type === "opaqueredirect") {
    throw new ErrorApi(0, "Tu sesión de Cloudflare Access venció. Recargá la página.");
  }

  const datos = await respuesta.json().catch(() => null);
  if (!respuesta.ok) {
    throw new ErrorApi(respuesta.status, datos?.mensaje ?? `Error ${respuesta.status}.`);
  }
  return datos;
}

// ─── Mensajes y vistas ───────────────────────────────────────────

function mostrarMensaje(texto, esError = false) {
  ui.mensaje.textContent = texto;
  ui.mensaje.classList.toggle("es-error", esError);
}

function mostrarPanel(visible) {
  ui.seccionAcceso.hidden = visible;
  ui.seccionPanel.hidden = !visible;
  ui.cerrarSesion.hidden = !visible;
}

/** Errores de API: si es 401, el token no sirve → volvemos al ingreso. */
function manejarError(error) {
  if (error instanceof ErrorApi && error.status === 401) {
    guardarToken("");
    mostrarPanel(false);
    mostrarMensaje("Token incorrecto o vencido. Ingresalo de nuevo.", true);
    return;
  }
  mostrarMensaje(error.message || "Ocurrió un error.", true);
}

// ─── Render de la tabla (sin innerHTML) ──────────────────────────

function crear(etiqueta, { texto, clase, atributos } = {}) {
  const elemento = document.createElement(etiqueta);
  if (texto !== undefined) elemento.textContent = texto;
  if (clase) elemento.className = clase;
  for (const [nombre, valor] of Object.entries(atributos ?? {})) elemento.setAttribute(nombre, valor);
  return elemento;
}

/**
 * Un <a href="..."> con un dato externo es peligroso aunque usemos
 * textContent para el texto: href="javascript:..." ejecuta código al
 * hacer clic. Por eso solo armamos el link si el protocolo es https:.
 */
function esUrlHttps(texto) {
  try {
    return new URL(texto).protocol === "https:";
  } catch {
    return false;
  }
}

function celdaDestino(destino) {
  const celda = crear("td", { clase: "celda-destino" });
  if (!destino) {
    celda.textContent = "—";
  } else if (esUrlHttps(destino)) {
    celda.append(
      crear("a", {
        texto: destino,
        atributos: { href: destino, target: "_blank", rel: "noopener noreferrer" },
      }),
    );
  } else {
    celda.textContent = destino;
  }
  return celda;
}

function celdaAcciones(enlace) {
  const celda = crear("td", { clase: "celda-acciones" });

  const editar = crear("button", { texto: "Editar", clase: "boton boton-secundario boton-chico", atributos: { type: "button" } });
  editar.addEventListener("click", () => abrirEdicion(enlace));

  const estaDesactivada = enlace.estado === "desactivada";
  const alternar = crear("button", {
    texto: estaDesactivada ? "Reactivar" : "Desactivar",
    clase: "boton boton-secundario boton-chico",
    atributos: { type: "button" },
  });
  alternar.addEventListener("click", () => (estaDesactivada ? reactivar(enlace) : desactivar(enlace)));

  const copiar = crear("button", { texto: "Copiar link", clase: "boton boton-secundario boton-chico", atributos: { type: "button" } });
  copiar.addEventListener("click", () => copiarLink(enlace.slug));

  // aria-label con el slug: "Editar panaderia-lopez" en vez de diez "Editar" iguales.
  for (const boton of [editar, alternar, copiar]) {
    boton.setAttribute("aria-label", `${boton.textContent} ${enlace.slug}`);
  }

  celda.append(editar, alternar, copiar);
  return celda;
}

function filaDeEnlace(enlace) {
  const fila = crear("tr");
  const celdaEstado = crear("td");
  celdaEstado.append(
    crear("span", {
      texto: NOMBRES_DE_ESTADO[enlace.estado] ?? enlace.estado,
      // El estado viene de la API: solo usamos clases que conocemos.
      clase: `insignia insignia-${Object.hasOwn(NOMBRES_DE_ESTADO, enlace.estado) ? enlace.estado : "desactivada"}`,
    }),
  );

  fila.append(
    crear("td", { texto: enlace.slug, clase: "celda-slug" }),
    crear("td", { texto: enlace.cliente || "—" }),
    celdaEstado,
    celdaDestino(enlace.destino),
    celdaAcciones(enlace),
  );
  return fila;
}

function enlacesFiltrados() {
  const texto = ui.filtroTexto.value.trim().toLowerCase();
  const estadoElegido = ui.filtroEstado.value;
  return estado.enlaces.filter((enlace) => {
    if (estadoElegido && enlace.estado !== estadoElegido) return false;
    if (!texto) return true;
    return [enlace.slug, enlace.cliente, enlace.destino].some((valor) => (valor ?? "").toLowerCase().includes(texto));
  });
}

function renderizar() {
  const visibles = enlacesFiltrados();
  ui.cuerpoTabla.replaceChildren(...visibles.map(filaDeEnlace));
  ui.vacio.hidden = visibles.length > 0;

  const contar = (valor) => estado.enlaces.filter((enlace) => enlace.estado === valor).length;
  ui.resumen.textContent =
    `${estado.enlaces.length} en total · ${contar("activa")} activos · ` +
    `${contar("sin_activar")} sin activar · ${contar("desactivada")} desactivados`;
}

// ─── Acciones ────────────────────────────────────────────────────

async function cargar() {
  try {
    const datos = await llamarApi("GET", API);
    estado.enlaces = datos.enlaces;
    mostrarPanel(true);
    renderizar();
  } catch (error) {
    manejarError(error);
  }
}

async function desactivar(enlace) {
  const confirmado = window.confirm(
    `¿Desactivar ${enlace.slug}? Quien escanee la placa va a ver "no encontrado". Se puede reactivar después.`,
  );
  if (!confirmado) return;
  try {
    await llamarApi("DELETE", `${API}/${encodeURIComponent(enlace.slug)}`);
    mostrarMensaje(`${enlace.slug} quedó desactivado.`);
    await cargar();
  } catch (error) {
    manejarError(error);
  }
}

async function reactivar(enlace) {
  try {
    await llamarApi("PUT", `${API}/${encodeURIComponent(enlace.slug)}`, { estado: "activa" });
    mostrarMensaje(`${enlace.slug} está activo otra vez.`);
    await cargar();
  } catch (error) {
    manejarError(error);
  }
}

async function copiarLink(slug) {
  const link = `${window.location.origin}/r/${slug}`;
  try {
    await navigator.clipboard.writeText(link);
    mostrarMensaje(`Copiado: ${link}`);
  } catch {
    mostrarMensaje(`No se pudo copiar. El link es: ${link}`, true);
  }
}

function abrirEdicion(enlace) {
  estado.editando = enlace;
  ui.editarSlug.textContent = enlace.slug;
  ui.formularioEditar.elements.destino.value = enlace.destino ?? "";
  ui.formularioEditar.elements.cliente.value = enlace.cliente ?? "";
  ui.formularioEditar.elements.estado.value = "";
  ui.errorEditar.textContent = "";
  ui.dialogo.showModal();
}

// ─── Eventos ─────────────────────────────────────────────────────

ui.formularioToken.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const token = ui.formularioToken.elements.token.value.trim();
  if (token.length < 32) {
    mostrarMensaje("El token tiene al menos 32 caracteres.", true);
    return;
  }
  guardarToken(token);
  ui.formularioToken.reset();
  mostrarMensaje("");
  await cargar();
});

ui.cerrarSesion.addEventListener("click", () => {
  guardarToken("");
  estado.enlaces = [];
  ui.cuerpoTabla.replaceChildren();
  mostrarPanel(false);
  mostrarMensaje("Sesión cerrada en esta pestaña.");
});

ui.formularioCrear.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const campos = ui.formularioCrear.elements;
  const cuerpo = {
    slug: campos.slug.value.trim(),
    destino: campos.destino.value.trim(),
    cliente: campos.cliente.value.trim(),
  };
  try {
    await llamarApi("POST", API, cuerpo);
    ui.formularioCrear.reset();
    mostrarMensaje(`Enlace ${cuerpo.slug} creado.`);
    await cargar();
  } catch (error) {
    manejarError(error);
  }
});

ui.formularioEditar.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const original = estado.editando;
  const campos = ui.formularioEditar.elements;

  // Mandamos SOLO lo que cambió.
  const cambios = {};
  const destino = campos.destino.value.trim();
  const cliente = campos.cliente.value.trim();
  if (destino && destino !== (original.destino ?? "")) cambios.destino = destino;
  if (cliente !== (original.cliente ?? "")) cambios.cliente = cliente;
  if (campos.estado.value) cambios.estado = campos.estado.value;

  if (Object.keys(cambios).length === 0) {
    ui.errorEditar.textContent = "No hay cambios para guardar.";
    return;
  }

  try {
    await llamarApi("PUT", `${API}/${encodeURIComponent(original.slug)}`, cambios);
    ui.dialogo.close();
    mostrarMensaje(`${original.slug} actualizado.`);
    await cargar();
  } catch (error) {
    if (error instanceof ErrorApi && error.status === 401) {
      ui.dialogo.close();
      manejarError(error);
    } else {
      ui.errorEditar.textContent = error.message;
    }
  }
});

ui.cancelarEdicion.addEventListener("click", () => ui.dialogo.close());
ui.filtroTexto.addEventListener("input", renderizar);
ui.filtroEstado.addEventListener("change", renderizar);
ui.recargar.addEventListener("click", cargar);

// ─── Inicio ──────────────────────────────────────────────────────
if (estado.token) cargar();
else mostrarPanel(false);
