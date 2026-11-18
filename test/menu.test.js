import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { colorSeguro, colorSobre, escapar, formatearPrecio, renderizarMenu, urlDeImagen } from "../src/lib/menu.js";
import { ErrorHttp } from "../src/lib/respuestas.js";
import { manejarMenu } from "../src/rutas/menu.js";

const ORIGEN = "https://abc.supabase.co";
const OPCIONES = { origen: ORIGEN, dominios: ["g.page"] };

const RESTAURANTE = {
  nombre: "La Casona",
  color: "#b5452b",
  resena_url: "https://g.page/r/XXXX/review",
  instagram: "lacasona",
  whatsapp: "5492664682314",
  categorias: [
    {
      id: "2",
      nombre: "Bebidas",
      orden: 2,
      productos: [{ id: "b", nombre: "Agua", precio: 2000, disponible: true, orden: 1 }],
    },
    {
      id: "1",
      nombre: "Entradas",
      orden: 1,
      productos: [
        { id: "a", nombre: "Provoleta", descripcion: "Con orégano", precio: 6500, disponible: true, orden: 1 },
        { id: "c", nombre: "Ravioles", precio: 12800.5, disponible: false, orden: 2 },
      ],
    },
  ],
};

describe("escapar", () => {
  it("neutraliza los caracteres que rompen HTML y atributos", () => {
    assert.equal(escapar(`<img src=x onerror="a()">&'`), "&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;");
  });
  it("tolera null y números", () => {
    assert.equal(escapar(null), "");
    assert.equal(escapar(5), "5");
  });
});

describe("formatearPrecio", () => {
  it("usa formato argentino", () => {
    assert.equal(formatearPrecio(6500), "$ 6.500");
    assert.equal(formatearPrecio(12800.5), "$ 12.800,50");
    assert.equal(formatearPrecio("1800"), "$ 1.800");
  });
  it("rechaza valores no válidos", () => {
    for (const malo of [-1, NaN, "abc", undefined, Infinity]) assert.equal(formatearPrecio(malo), "");
  });
});

describe("urlDeImagen", () => {
  const ok = `${ORIGEN}/storage/v1/object/public/menu/plato.jpg`;
  it("acepta el Storage público de nuestro proyecto", () => {
    assert.equal(urlDeImagen(ok, ORIGEN), ok);
  });
  it("rechaza otros hosts, esquemas y rutas", () => {
    const malas = [
      "https://sitio-malo.com/storage/v1/object/public/x.jpg",
      "https://abc.supabase.co.sitio-malo.com/storage/v1/object/public/x.jpg",
      "https://abc.supabase.co@sitio-malo.com/storage/v1/object/public/x.jpg",
      "http://abc.supabase.co/storage/v1/object/public/x.jpg",
      `${ORIGEN}/rest/v1/restaurantes`,
      "javascript:alert(1)",
      "data:image/svg+xml,<svg/>",
      "no es una url",
      null,
      42,
      `${ok}${"a".repeat(600)}`,
    ];
    for (const mala of malas) assert.equal(urlDeImagen(mala, ORIGEN), null, String(mala));
  });
});

describe("color", () => {
  it("solo acepta #rrggbb", () => {
    assert.equal(colorSeguro("#B5452B"), "#b5452b");
    for (const malo of ["red", "#fff", "#12345", "#12345g", "#123456;}</style><script>", null, 7]) {
      assert.equal(colorSeguro(malo), "#14213d", String(malo));
    }
  });
  it("elige texto legible sobre el color", () => {
    assert.equal(colorSobre("#ffffff"), "#111827");
    assert.equal(colorSobre("#000000"), "#ffffff");
    assert.equal(colorSobre("#14213d"), "#ffffff");
    assert.equal(colorSobre("#f2a541"), "#111827");
  });
});

describe("renderizarMenu", () => {
  it("ordena categorías y platos, y marca los no disponibles", () => {
    const { html } = renderizarMenu(RESTAURANTE, OPCIONES);
    assert.ok(html.indexOf("Entradas") < html.indexOf("Bebidas"));
    assert.ok(html.indexOf("Provoleta") < html.indexOf("Ravioles"));
    assert.match(html, /\$ 6\.500/);
    assert.match(html, /class="plato agotado"/);
    assert.match(html, /No disponible/);
  });

  it("incluye botón de reseña, Instagram y WhatsApp", () => {
    const { html } = renderizarMenu(RESTAURANTE, OPCIONES);
    assert.match(html, /href="https:\/\/g\.page\/r\/XXXX\/review"[^>]*>Dejanos tu reseña/);
    assert.match(html, /href="https:\/\/www\.instagram\.com\/lacasona\/"/);
    assert.match(html, /href="https:\/\/wa\.me\/5492664682314"/);
  });

  it("el <style> inline solo contiene el color y el contraste", () => {
    const { estilo, html } = renderizarMenu(RESTAURANTE, OPCIONES);
    assert.equal(estilo, ":root{--color:#b5452b;--sobre-color:#ffffff}");
    assert.ok(html.includes(`<style>${estilo}</style>`));
  });

  it("no deja pasar HTML ni atributos inyectados desde los datos", () => {
    const ataque = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
    const { html, estilo } = renderizarMenu(
      {
        nombre: ataque,
        color: "red;}</style><script>alert(3)</script>",
        logo_url: `javascript:alert(4)`,
        resena_url: "javascript:alert(5)",
        instagram: ataque,
        whatsapp: ataque,
        categorias: [
          {
            nombre: ataque,
            orden: 1,
            productos: [
              { nombre: ataque, descripcion: ataque, precio: "1; drop table", foto_url: `${ORIGEN}/x"onerror="alert(6)`, disponible: true },
            ],
          },
        ],
      },
      OPCIONES,
    );
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /<img src=x/i);
    assert.doesNotMatch(html, /javascript:/i);
    // El texto "onerror=" puede aparecer escapado como contenido; lo que no
    // puede pasar es que sea un atributo real dentro de una etiqueta.
    const sinValores = html.replace(/"[^"]*"/g, '""'); // valores entre comillas: texto inerte
    assert.doesNotMatch(sinValores, /<[^>]*\son\w+=/i);
    assert.doesNotMatch(html, /drop table/);
    assert.match(estilo, /^:root\{--color:#14213d;/);
  });

  it("ignora links de reseña de dominios no permitidos", () => {
    const { html } = renderizarMenu({ ...RESTAURANTE, resena_url: "https://sitio-malo.com/review" }, OPCIONES);
    assert.doesNotMatch(html, /sitio-malo/);
    assert.doesNotMatch(html, /Dejanos tu reseña/);
  });

  it("muestra un aviso si no hay platos", () => {
    const { html } = renderizarMenu({ nombre: "Vacío", categorias: [] }, OPCIONES);
    assert.match(html, /Estamos preparando el menú/);
  });

  it("solo muestra el menú de categorías si hay más de una", () => {
    assert.match(renderizarMenu(RESTAURANTE, OPCIONES).html, /class="categorias"/);
    const una = { ...RESTAURANTE, categorias: [RESTAURANTE.categorias[0]] };
    assert.doesNotMatch(renderizarMenu(una, OPCIONES).html, /class="categorias"/);
  });
});

describe("manejarMenu (Supabase simulado)", () => {
  const fetchOriginal = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = fetchOriginal;
  });

  const env = {
    SUPABASE_URL: ORIGEN,
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_de_prueba",
    DOMINIOS_PERMITIDOS: "g.page",
    ASSETS: { fetch: async () => new Response("<h1>404</h1>") },
  };
  const pedido = (ruta, metodo = "GET") => new Request(`https://nodosnfc.com.ar${ruta}`, { method: metodo });

  it("consulta Supabase con apikey y devuelve el menú con su CSP", async () => {
    let llamada;
    globalThis.fetch = async (url, init) => {
      llamada = { url: new URL(url), init };
      return Response.json([RESTAURANTE]);
    };

    const r = await manejarMenu(pedido("/m/lacasona"), env, ["lacasona"]);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /La Casona/);

    assert.equal(llamada.url.origin, ORIGEN);
    assert.equal(llamada.url.pathname, "/rest/v1/restaurantes");
    assert.equal(llamada.url.searchParams.get("slug"), "eq.lacasona");
    assert.equal(llamada.url.searchParams.get("activo"), "eq.true");
    assert.equal(llamada.init.headers.apikey, "sb_publishable_de_prueba");
    assert.equal(llamada.init.headers.Authorization, undefined);

    const csp = r.headers.get("Content-Security-Policy");
    assert.match(csp, /script-src 'none'/);
    assert.match(csp, new RegExp(`img-src 'self' ${ORIGEN}`));
    assert.match(csp, /style-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.match(r.headers.get("Cache-Control"), /s-maxage=120/);
  });

  it("responde 404 si el restaurante no existe o está inactivo", async () => {
    globalThis.fetch = async () => Response.json([]);
    const r = await manejarMenu(pedido("/m/nadie"), env, ["nadie"]);
    assert.equal(r.status, 404);
  });

  it("un slug inválido da 404 sin llamar a Supabase", async () => {
    let llamadas = 0;
    globalThis.fetch = async () => {
      llamadas++;
      return Response.json([]);
    };
    for (const slug of ["MAYUS", "con espacio", "a".repeat(41), "x&activo=eq.false", "../etc"]) {
      const r = await manejarMenu(pedido("/m/x"), env, [slug]);
      assert.equal(r.status, 404, slug);
    }
    assert.equal(llamadas, 0);
  });

  it("HEAD devuelve los headers sin cuerpo", async () => {
    globalThis.fetch = async () => Response.json([RESTAURANTE]);
    const r = await manejarMenu(pedido("/m/lacasona", "HEAD"), env, ["lacasona"]);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "");
  });

  it("si Supabase falla, responde 503 y no filtra detalles", async () => {
    globalThis.fetch = async () => new Response("clave secreta interna", { status: 500 });
    await assert.rejects(manejarMenu(pedido("/m/lacasona"), env, ["lacasona"]), (e) => e instanceof ErrorHttp && e.status === 503);

    globalThis.fetch = async () => {
      throw new Error("timeout");
    };
    await assert.rejects(manejarMenu(pedido("/m/lacasona"), env, ["lacasona"]), (e) => e instanceof ErrorHttp && e.status === 503);
  });

  it("sin configuración responde 503", async () => {
    globalThis.fetch = async () => assert.fail("no debería llamar a Supabase");
    for (const vacio of [{ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "" }, { SUPABASE_URL: "http://inseguro.com", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x_x" }]) {
      await assert.rejects(manejarMenu(pedido("/m/lacasona"), { ...env, ...vacio }, ["lacasona"]), (e) => e instanceof ErrorHttp && e.status === 503);
    }
  });
});
