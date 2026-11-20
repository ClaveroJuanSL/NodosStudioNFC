// ─────────────────────────────────────────────────────────────────
// panel.js — Panel de clientes del menú digital.
//
// Corre en el NAVEGADOR y habla directo con Supabase. Eso es seguro porque:
//   • la clave publishable es pública por diseño (puede estar en el código);
//   • cuando el usuario inicia sesión, cada pedido viaja con SU token, y las
//     políticas RLS de la base (supabase/panel.sql) deciden qué filas puede
//     ver y modificar. Si este archivo se modificara a mano en el navegador,
//     la base igual rechazaría lo que no le corresponde.
//
// Regla anti-XSS: NUNCA se usa innerHTML. Todo dato se muestra con
// textContent (los nombres y descripciones los escriben usuarios).
// ─────────────────────────────────────────────────────────────────

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "./config.js";
import {
  BUCKET_FOTOS,
  PESO_MAXIMO_FOTO,
  PESO_MAXIMO_ORIGINAL,
  calcularTamano,
  leerOrden,
  leerPrecio,
  mostrarPrecio,
  rutaDeFoto,
  rutaDesdeUrl,
} from "./utiles.js";

// `supabase` lo define public/vendor/supabase.js (se carga antes que este módulo).
const cliente = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const $ = (selector) => document.querySelector(selector);
const mensaje = $("[data-mensaje]");
const secciones = {
  login: $("[data-seccion-login]"),
  sinLocal: $("[data-seccion-sin-local]"),
  panel: $("[data-seccion-panel]"),
};
const botonSalir = $("[data-cerrar-sesion]");
const listaCategorias = $("[data-lista-categorias]");
const dialogoCategoria = $("[data-dialogo-categoria]");
const dialogoProducto = $("[data-dialogo-producto]");

const estado = {
  locales: [],
  local: null,
  categorias: [],
  edicionCategoria: null, // null = creando; objeto = editando
  edicionProducto: null, // { categoria, producto|null }
};

// ─── Utilidades ──────────────────────────────────────────────────

/** Crea un elemento. Los hijos de tipo texto van como nodos de texto, no como HTML. */
function el(etiqueta, atributos = {}, ...hijos) {
  const nodo = document.createElement(etiqueta);
  for (const [clave, valor] of Object.entries(atributos)) {
    if (valor === false || valor == null) continue;
    if (clave === "texto") nodo.textContent = valor;
    else nodo.setAttribute(clave, valor === true ? "" : valor);
  }
  nodo.append(...hijos);
  return nodo;
}

function avisar(texto, esError = false) {
  mensaje.textContent = texto;
  mensaje.classList.toggle("es-error", esError);
}

function vista(nombre) {
  for (const [clave, seccion] of Object.entries(secciones)) seccion.hidden = clave !== nombre;
  botonSalir.hidden = nombre === "login";
}

/** Traduce el error de Supabase a un mensaje para la persona (sin detalles técnicos). */
function describirError(error) {
  if (error) console.error("Supabase:", error.code, error.message);
  // Los errores de Storage no traen "code" de Postgres: se reconocen por estado/mensaje.
  if (error?.code === "42501" || error?.statusCode === "403" || /row-level security/i.test(error?.message ?? "")) {
    return "No tenés permiso para hacer esto.";
  }
  if (error?.statusCode === "413") return "La foto es demasiado pesada.";
  if (error?.code === "23514" || error?.code === "22001") return "Algún dato no es válido o es demasiado largo.";
  if (error?.code === "23505") return "Ya existe un elemento con esos datos.";
  return "No se pudo completar la acción. Probá de nuevo en unos minutos.";
}

/** Deshabilita el botón de enviar mientras dura la operación (evita doble envío). */
async function conBloqueo(formulario, tarea) {
  const botones = formulario.querySelectorAll("button");
  botones.forEach((b) => (b.disabled = true));
  try {
    return await tarea();
  } finally {
    botones.forEach((b) => (b.disabled = false));
  }
}

// ─── Sesión ──────────────────────────────────────────────────────

async function iniciar() {
  const { data } = await cliente.auth.getSession();
  if (!data.session) return vista("login");
  await cargarLocales();
}

// OJO: dentro de este callback no se hacen pedidos a Supabase (puede trabarse
// la librería). Solo cambiamos de pantalla, y diferido con setTimeout.
cliente.auth.onAuthStateChange((evento) => {
  if (evento === "SIGNED_OUT") setTimeout(() => limpiarYMostrarLogin(), 0);
});

function limpiarYMostrarLogin() {
  estado.locales = [];
  estado.local = null;
  estado.categorias = [];
  listaCategorias.replaceChildren(); // no dejamos datos en pantalla tras salir
  vista("login");
}

$("[data-formulario-login]").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const formulario = evento.currentTarget;
  const email = formulario.email.value.trim();
  const clave = formulario.clave.value;
  if (!email || !clave) return avisar("Completá el email y la contraseña.", true);

  await conBloqueo(formulario, async () => {
    const { error } = await cliente.auth.signInWithPassword({ email, password: clave });
    formulario.clave.value = "";
    if (error) {
      // Mensaje único: no revelamos si el email existe o si falló la contraseña.
      return avisar(error.status === 429 ? "Demasiados intentos. Esperá unos minutos." : "Email o contraseña incorrectos.", true);
    }
    avisar("");
    await cargarLocales();
  });
});

botonSalir.addEventListener("click", async () => {
  await cliente.auth.signOut();
  limpiarYMostrarLogin();
  avisar("Cerraste sesión.");
});

// ─── Carga de datos ──────────────────────────────────────────────

async function cargarLocales() {
  // RLS: "miembros" solo devuelve MIS vínculos; "restaurantes" solo los míos.
  const { data, error } = await cliente.from("miembros").select("restaurantes(id,slug,nombre,activo)");
  if (error) {
    vista("login");
    return avisar(describirError(error), true);
  }

  estado.locales = data
    .map((fila) => fila.restaurantes)
    .filter(Boolean)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

  if (estado.locales.length === 0) return vista("sinLocal");

  const selector = $("[data-selector]");
  selector.replaceChildren(...estado.locales.map((l) => el("option", { value: l.id, texto: l.nombre })));
  $("[data-selector-local]").hidden = estado.locales.length < 2;

  estado.local = estado.locales[0];
  selector.value = estado.local.id;
  vista("panel");
  await cargarCategorias();
}

$("[data-selector]").addEventListener("change", async (evento) => {
  estado.local = estado.locales.find((l) => l.id === evento.target.value) ?? estado.locales[0];
  await cargarCategorias();
});

async function cargarCategorias() {
  const { local } = estado;
  $("[data-titulo-local]").textContent = local.activo ? local.nombre : `${local.nombre} (menú pausado)`;
  $("[data-enlace-menu]").href = `/m/${encodeURIComponent(local.slug)}`;

  const { data, error } = await cliente
    .from("categorias")
    .select("id,nombre,orden,productos(id,nombre,descripcion,precio,foto_url,disponible,orden)")
    .eq("restaurante_id", local.id)
    .order("orden");
  if (error) return avisar(describirError(error), true);

  estado.categorias = data.map((c) => ({
    ...c,
    productos: [...c.productos].sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, "es")),
  }));
  renderizar();
}

// ─── Dibujo de la pantalla ───────────────────────────────────────

function renderizar() {
  listaCategorias.replaceChildren(...estado.categorias.map(tarjetaCategoria));
  $("[data-vacio]").hidden = estado.categorias.length > 0;
}

function boton(texto, clase, alHacerClick) {
  const b = el("button", { type: "button", class: `boton ${clase} boton-chico`, texto });
  b.addEventListener("click", alHacerClick);
  return b;
}

function tarjetaCategoria(categoria) {
  const lista = categoria.productos.length
    ? el("ul", { class: "lista-platos" }, ...categoria.productos.map((p) => filaProducto(categoria, p)))
    : el("p", { class: "sin-platos", texto: "Esta categoría todavía no tiene platos." });

  return el(
    "section",
    { class: "categoria", "aria-label": categoria.nombre },
    el(
      "div",
      { class: "categoria-cabecera" },
      el("h3", { texto: categoria.nombre }),
      el(
        "div",
        { class: "grupo-botones" },
        boton("Agregar plato", "boton-primario", () => abrirDialogoProducto(categoria, null)),
        boton("Editar", "boton-secundario", () => abrirDialogoCategoria(categoria)),
        boton("Borrar", "boton-peligro", () => borrarCategoria(categoria)),
      ),
    ),
    lista,
  );
}

function filaProducto(categoria, producto) {
  const casilla = el("input", { type: "checkbox", id: `disp-${producto.id}`, checked: producto.disponible });
  casilla.addEventListener("change", () => cambiarDisponibilidad(producto, casilla));

  // Solo mostramos fotos que estén en NUESTRO Storage (la CSP bloquearía el resto).
  const urlFoto = rutaDesdeUrl(producto.foto_url, SUPABASE_URL) ? producto.foto_url : null;

  return el(
    "li",
    { class: `plato-fila${producto.disponible ? "" : " plato-agotado"}` },
    el(
      "div",
      { class: "plato-info" },
      urlFoto ? el("img", { class: "plato-miniatura", src: urlFoto, alt: "", width: "56", height: "56", loading: "lazy" }) : "",
      el(
        "div",
        {},
        el("span", { class: "plato-nombre", texto: producto.nombre }),
        el("span", { class: "plato-precio", texto: mostrarPrecio(producto.precio) }),
        producto.descripcion ? el("p", { class: "plato-descripcion", texto: producto.descripcion }) : "",
      ),
    ),
    el(
      "div",
      { class: "grupo-botones" },
      el("label", { class: "casilla-disponible", for: casilla.id }, casilla, "Disponible"),
      boton("Editar", "boton-secundario", () => abrirDialogoProducto(categoria, producto)),
      boton("Borrar", "boton-peligro", () => borrarProducto(producto)),
    ),
  );
}

// ─── Categorías: crear, editar, borrar ───────────────────────────

$("[data-nueva-categoria]").addEventListener("click", () => abrirDialogoCategoria(null));

function abrirDialogoCategoria(categoria) {
  estado.edicionCategoria = categoria;
  const f = $("[data-formulario-categoria]");
  $("[data-titulo-dlg-categoria]").textContent = categoria ? "Editar categoría" : "Nueva categoría";
  f.nombre.value = categoria?.nombre ?? "";
  f.orden.value = categoria?.orden ?? siguienteOrden(estado.categorias);
  $("[data-error-categoria]").textContent = "";
  dialogoCategoria.showModal();
  f.nombre.focus();
}

function siguienteOrden(elementos) {
  return elementos.reduce((max, e) => Math.max(max, e.orden), 0) + 1;
}

$("[data-formulario-categoria]").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const f = evento.currentTarget;
  const error = $("[data-error-categoria]");
  const nombre = f.nombre.value.trim();
  const orden = leerOrden(f.orden.value, siguienteOrden(estado.categorias));
  if (!nombre) return (error.textContent = "Escribí un nombre.");
  if (orden === null) return (error.textContent = "El orden tiene que ser un número entre 0 y 9999.");

  await conBloqueo(f, async () => {
    const editando = estado.edicionCategoria;
    const consulta = editando
      ? cliente.from("categorias").update({ nombre, orden }).eq("id", editando.id)
      : cliente.from("categorias").insert({ restaurante_id: estado.local.id, nombre, orden });
    // .select() devuelve las filas afectadas: si RLS bloquea un UPDATE no hay
    // error, simplemente 0 filas. Por eso comprobamos que haya al menos una.
    const { data, error: fallo } = await consulta.select("id");
    if (fallo || !data?.length) return (error.textContent = describirError(fallo ?? { code: "42501" }));
    dialogoCategoria.close();
    avisar(editando ? "Categoría actualizada." : "Categoría creada.");
    await cargarCategorias();
  });
});

async function borrarCategoria(categoria) {
  const cuantos = categoria.productos.length;
  const aviso = cuantos
    ? `¿Borrar la categoría "${categoria.nombre}" y sus ${cuantos} plato(s)? No se puede deshacer.`
    : `¿Borrar la categoría "${categoria.nombre}"?`;
  if (!window.confirm(aviso)) return;

  const { data, error } = await cliente.from("categorias").delete().eq("id", categoria.id).select("id");
  if (error || !data?.length) return avisar(describirError(error ?? { code: "42501" }), true);
  await borrarFotos(categoria.productos.map((p) => p.foto_url)); // los platos se borraron en cascada
  avisar("Categoría borrada.");
  await cargarCategorias();
}

// ─── Platos: crear, editar, borrar, disponibilidad ───────────────

function abrirDialogoProducto(categoria, producto) {
  estado.edicionProducto = { categoria, producto };
  const f = $("[data-formulario-producto]");
  $("[data-titulo-dlg-producto]").textContent = producto ? "Editar plato" : `Nuevo plato en ${categoria.nombre}`;
  f.nombre.value = producto?.nombre ?? "";
  f.descripcion.value = producto?.descripcion ?? "";
  f.precio.value = producto ? String(producto.precio).replace(".", ",") : "";
  f.orden.value = producto?.orden ?? siguienteOrden(categoria.productos);
  f.disponible.checked = producto ? producto.disponible : true;
  $("[data-error-producto]").textContent = "";
  reiniciarFoto(producto);
  dialogoProducto.showModal();
  f.nombre.focus();
}

$("[data-formulario-producto]").addEventListener("submit", async (evento) => {
  evento.preventDefault();
  const f = evento.currentTarget;
  const error = $("[data-error-producto]");
  const { categoria, producto } = estado.edicionProducto;

  const nombre = f.nombre.value.trim();
  const descripcion = f.descripcion.value.trim();
  const precio = leerPrecio(f.precio.value);
  const orden = leerOrden(f.orden.value, siguienteOrden(categoria.productos));
  if (!nombre) return (error.textContent = "Escribí un nombre.");
  if (precio === null) return (error.textContent = "El precio no es válido. Ej.: 6500 o 14500,50.");
  if (orden === null) return (error.textContent = "El orden tiene que ser un número entre 0 y 9999.");

  const datos = { nombre, descripcion: descripcion || null, precio, orden, disponible: f.disponible.checked };

  await conBloqueo(f, async () => {
    // 1) Primero se sube la foto (si hay una nueva); 2) recién después se guarda
    // el plato con su link. Así nunca queda un plato apuntando a una foto que no existe.
    let fotoUrl = producto?.foto_url ?? null;
    let rutaSubida = null;
    if (foto.accion === "nueva") {
      const ruta = rutaDeFoto(estado.local.id, foto.tipo, crypto.randomUUID());
      const { error: fallaSubida } = await cliente.storage
        .from(BUCKET_FOTOS)
        // Nombre único + cache de 1 año: la foto nunca cambia, se reemplaza por otra.
        .upload(ruta, foto.blob, { contentType: foto.tipo, cacheControl: "31536000", upsert: false });
      if (fallaSubida) return (error.textContent = describirError(fallaSubida));
      rutaSubida = ruta;
      fotoUrl = cliente.storage.from(BUCKET_FOTOS).getPublicUrl(ruta).data.publicUrl;
    } else if (foto.accion === "quitar") {
      fotoUrl = null;
    }

    const datosFinales = { ...datos, foto_url: fotoUrl };
    const consulta = producto
      ? cliente.from("productos").update(datosFinales).eq("id", producto.id)
      : cliente.from("productos").insert({ ...datosFinales, restaurante_id: estado.local.id, categoria_id: categoria.id });
    const { data, error: fallo } = await consulta.select("id");
    if (fallo || !data?.length) {
      // Si el guardado falló, la foto recién subida quedaría huérfana: la borramos.
      if (rutaSubida) await cliente.storage.from(BUCKET_FOTOS).remove([rutaSubida]);
      return (error.textContent = describirError(fallo ?? { code: "42501" }));
    }
    // Ya está guardado: la foto anterior (si la hubo y cambió) ya no se usa.
    if (producto?.foto_url && producto.foto_url !== fotoUrl) await borrarFotos([producto.foto_url]);
    dialogoProducto.close();
    avisar(producto ? "Plato actualizado." : "Plato creado.");
    await cargarCategorias();
  });
});

async function cambiarDisponibilidad(producto, casilla) {
  const nuevo = casilla.checked;
  casilla.disabled = true;
  const { data, error } = await cliente.from("productos").update({ disponible: nuevo }).eq("id", producto.id).select("id");
  if (error || !data?.length) {
    casilla.checked = !nuevo; // volvemos atrás: el cambio NO se guardó
    casilla.disabled = false;
    return avisar(describirError(error ?? { code: "42501" }), true);
  }
  avisar(nuevo ? `«${producto.nombre}» marcado como disponible.` : `«${producto.nombre}» marcado como no disponible.`);
  await cargarCategorias();
}

async function borrarProducto(producto) {
  if (!window.confirm(`¿Borrar el plato "${producto.nombre}"? No se puede deshacer.`)) return;
  const { data, error } = await cliente.from("productos").delete().eq("id", producto.id).select("id");
  if (error || !data?.length) return avisar(describirError(error ?? { code: "42501" }), true);
  await borrarFotos([producto.foto_url]);
  avisar("Plato borrado.");
  await cargarCategorias();
}

// ─── Fotos ───────────────────────────────────────────────────────

// Estado de la foto del plato que se está editando:
//   "mantener": no se toca · "nueva": hay una foto comprimida lista · "quitar": se borra
const foto = { accion: "mantener", blob: null, tipo: null, urlBlob: null };
const previa = $("[data-foto-previa]");
const entradaFoto = $("[data-entrada-foto]");
const botonQuitarFoto = $("[data-quitar-foto]");
const estadoFoto = $("[data-estado-foto]");

function liberarBlob() {
  if (foto.urlBlob) URL.revokeObjectURL(foto.urlBlob); // libera la memoria de la vista previa
  foto.urlBlob = null;
}

function ponerPrevia(url) {
  if (url) previa.src = url;
  else previa.removeAttribute("src");
  previa.hidden = !url;
  botonQuitarFoto.hidden = !url;
}

function reiniciarFoto(producto) {
  liberarBlob();
  Object.assign(foto, { accion: "mantener", blob: null, tipo: null });
  entradaFoto.value = "";
  estadoFoto.textContent = "";
  ponerPrevia(producto && rutaDesdeUrl(producto.foto_url, SUPABASE_URL) ? producto.foto_url : null);
}

/**
 * Achica y recomprime la imagen ANTES de subirla. Pasarla por un <canvas>:
 *   • reduce el peso (una foto de celular de 4 MB queda en ~100-200 KB),
 *   • borra los metadatos (incluida la ubicación GPS de la foto),
 *   • deja la imagen derecha (createImageBitmap aplica la rotación EXIF).
 * Devuelve { blob, tipo } o lanza un Error con un mensaje para la persona.
 */
async function comprimirImagen(archivo) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(archivo.type)) {
    throw new Error("Elegí una foto JPG, PNG o WebP.");
  }
  if (archivo.size > PESO_MAXIMO_ORIGINAL) throw new Error("La foto es demasiado grande (máximo 20 MB).");

  let imagen;
  try {
    imagen = await createImageBitmap(archivo, { imageOrientation: "from-image" });
  } catch {
    throw new Error("No se pudo leer la imagen. Probá con otra foto.");
  }

  const tamano = calcularTamano(imagen.width, imagen.height);
  const lienzo = document.createElement("canvas");
  lienzo.width = tamano.ancho;
  lienzo.height = tamano.alto;
  const contexto = lienzo.getContext("2d");
  contexto.fillStyle = "#ffffff"; // los PNG con transparencia no quedan negros
  contexto.fillRect(0, 0, tamano.ancho, tamano.alto);
  contexto.drawImage(imagen, 0, 0, tamano.ancho, tamano.alto);
  imagen.close?.();

  // WebP pesa menos; si el navegador no lo sabe generar, cae a JPEG.
  // Si queda muy pesada, se baja la calidad de a poco.
  for (const tipo of ["image/webp", "image/jpeg"]) {
    for (const calidad of [0.82, 0.65, 0.5]) {
      const blob = await new Promise((resolver) => lienzo.toBlob(resolver, tipo, calidad));
      if (!blob || blob.type !== tipo) break; // el navegador no soporta este formato
      if (blob.size <= PESO_MAXIMO_FOTO) return { blob, tipo };
    }
  }
  throw new Error("No se pudo reducir lo suficiente el peso de la foto. Probá con otra.");
}

entradaFoto.addEventListener("change", async () => {
  const archivo = entradaFoto.files[0];
  const error = $("[data-error-producto]");
  error.textContent = "";
  if (!archivo) return;

  estadoFoto.textContent = "Preparando la foto…";
  try {
    const { blob, tipo } = await comprimirImagen(archivo);
    liberarBlob();
    foto.urlBlob = URL.createObjectURL(blob);
    Object.assign(foto, { accion: "nueva", blob, tipo });
    ponerPrevia(foto.urlBlob);
    estadoFoto.textContent = `Foto lista (${Math.round(blob.size / 1024)} KB).`;
  } catch (fallo) {
    entradaFoto.value = "";
    estadoFoto.textContent = "";
    error.textContent = fallo.message;
  }
});

botonQuitarFoto.addEventListener("click", () => {
  liberarBlob();
  Object.assign(foto, { accion: "quitar", blob: null, tipo: null });
  entradaFoto.value = "";
  estadoFoto.textContent = "La foto se quitará al guardar.";
  ponerPrevia(null);
});

/** Borra fotos del Storage. Es "mejor esfuerzo": si falla, el plato ya quedó bien guardado. */
async function borrarFotos(urls) {
  const rutas = urls.map((u) => rutaDesdeUrl(u, SUPABASE_URL)).filter(Boolean);
  if (rutas.length === 0) return;
  const { error } = await cliente.storage.from(BUCKET_FOTOS).remove(rutas);
  if (error) console.error("No se pudieron borrar fotos viejas:", error.message);
}

// ─── Diálogos: cancelar ──────────────────────────────────────────

for (const cancelar of document.querySelectorAll("[data-cancelar-dialogo]")) {
  cancelar.addEventListener("click", () => cancelar.closest("dialog").close());
}

iniciar();
