import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from "../public/panel/config.js";
import {
  calcularTamano,
  leerOrden,
  leerPrecio,
  mostrarPrecio,
  rutaDeFoto,
  rutaDesdeUrl,
} from "../public/panel/utiles.js";

const leer = (ruta) => readFileSync(new URL(`../${ruta}`, import.meta.url), "utf8");

/** Quita comentarios de línea completa, de bloque y de HTML: solo revisamos CÓDIGO. */
const sinComentarios = (texto) =>
  texto.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*(\/\/|\/\*\*|\*).*$/gm, "");

describe("leerPrecio", () => {
  it("acepta los formatos argentinos habituales", () => {
    const casos = [
      ["6500", 6500],
      ["6.500", 6500],
      ["14500,50", 14500.5],
      ["14.500,50", 14500.5],
      ["1.234.567", 1234567],
      ["6.50", 6.5],
      ["0", 0],
      ["$ 2500", 2500],
      ["  1800  ", 1800],
    ];
    for (const [entrada, esperado] of casos) assert.equal(leerPrecio(entrada), esperado, entrada);
  });

  it("rechaza lo que no es un precio", () => {
    for (const malo of ["", "abc", "-5", "1,2,3", "12.5.5", "1e5", "1; drop table", "6500,555", "100000000", "NaN", "∞"]) {
      assert.equal(leerPrecio(malo), null, malo);
    }
  });
});

describe("leerOrden", () => {
  it("usa el valor por defecto si está vacío y valida el rango", () => {
    assert.equal(leerOrden("", 7), 7);
    assert.equal(leerOrden("  ", 7), 7);
    assert.equal(leerOrden("0", 7), 0);
    assert.equal(leerOrden("9999", 7), 9999);
    for (const malo of ["-1", "10000", "1.5", "abc"]) assert.equal(leerOrden(malo, 7), null, malo);
  });
});

describe("mostrarPrecio", () => {
  it("formatea en es-AR", () => {
    assert.equal(mostrarPrecio(6500), "$ 6.500");
    assert.equal(mostrarPrecio("14500.50"), "$ 14.500,50");
    assert.equal(mostrarPrecio(undefined), "");
  });
});

describe("configuración de Supabase coherente en los tres lugares", () => {
  const wrangler = leer("wrangler.toml");
  const encabezados = leer("public/_headers");

  it("config.js coincide con wrangler.toml", () => {
    assert.equal(wrangler.match(/^SUPABASE_URL\s*=\s*"([^"]+)"/m)?.[1], SUPABASE_URL);
    assert.equal(wrangler.match(/^SUPABASE_PUBLISHABLE_KEY\s*=\s*"([^"]+)"/m)?.[1], SUPABASE_PUBLISHABLE_KEY);
  });

  it("la clave es una publishable (nunca una secret ni una service_role)", () => {
    assert.match(SUPABASE_PUBLISHABLE_KEY, /^sb_publishable_/);
    assert.match(SUPABASE_URL, /^https:\/\/[a-z0-9]+\.supabase\.co$/);
  });

  it("la CSP de /panel/* permite solo el host de Supabase, y está después de /*", () => {
    const lineas = encabezados.split(/\r?\n/);
    const inicio = lineas.findIndex((l) => l.trim() === "/panel/*");
    assert.ok(inicio > lineas.findIndex((l) => l.trim() === "/*"), "/panel/* tiene que ir DESPUÉS de /*");

    const bloque = [];
    for (const linea of lineas.slice(inicio + 1)) {
      if (!/^\s+\S/.test(linea)) break;
      bloque.push(linea.trim());
    }
    const desacople = bloque.indexOf("! Content-Security-Policy");
    const csp = bloque.find((l) => l.startsWith("Content-Security-Policy:"));
    assert.notEqual(desacople, -1, "falta desacoplar la CSP global con '!'");
    assert.ok(csp, "falta la CSP propia del panel");
    assert.ok(bloque.indexOf(csp) > desacople, "el '!' tiene que ir antes de la CSP propia");

    assert.match(csp, new RegExp(`connect-src 'self' ${SUPABASE_URL.replaceAll(".", "\\.")}(;|$)`));
    assert.ok(csp.includes(`img-src 'self' ${SUPABASE_URL} blob:;`), "img-src: solo 'self', Supabase y blob: (vista previa)");
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
    assert.ok(bloque.includes("Cache-Control: no-store"));
  });
});

describe("el código del panel no tiene patrones peligrosos", () => {
  const js = sinComentarios(leer("public/panel/panel.js"));
  const html = sinComentarios(leer("public/panel/index.html"));

  it("no usa innerHTML ni equivalentes (todo con textContent)", () => {
    assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  });

  it("el HTML no tiene scripts, estilos ni eventos inline (la CSP los bloquearía)", () => {
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i);
    assert.doesNotMatch(html, /<style/i);
    assert.doesNotMatch(html, /\sstyle=/i);
    assert.doesNotMatch(html, /\son[a-z]+=/i);
  });

  it("no hay claves secretas en el código del navegador", () => {
    for (const archivo of ["public/panel/panel.js", "public/panel/config.js", "public/panel/index.html"]) {
      assert.doesNotMatch(sinComentarios(leer(archivo)), /sb_secret_|service_role|eyJ[A-Za-z0-9_-]{20,}/, archivo);
    }
  });
});

describe("supabase/panel.sql", () => {
  const sql = leer("supabase/panel.sql").replace(/--.*$/gm, ""); // sin comentarios

  it("no le da permisos de escritura al rol anónimo ni abre políticas con 'true'", () => {
    assert.doesNotMatch(sql, /grant[^;]*\bto\b[^;]*\banon\b/i);
    assert.doesNotMatch(sql, /using\s*\(\s*true\s*\)|with check\s*\(\s*true\s*\)/i);
    assert.doesNotMatch(sql, /to\s+anon/i);
  });

  it("toda política de escritura exige ser miembro del restaurante", () => {
    const politicas = sql.match(/create policy[\s\S]*?;/gi) ?? [];
    const escritura = politicas.filter((p) => /for\s+(insert|update|delete)/i.test(p));
    assert.equal(escritura.length, 6);
    for (const p of escritura) assert.match(p, /es_miembro\(restaurante_id\)/, p);
  });

  it("la función auxiliar fija el search_path y no es ejecutable por anon", () => {
    assert.match(sql, /security definer\s+set search_path = ''/i);
    assert.match(sql, /revoke all on function public\.es_miembro\(uuid\) from public, anon/i);
  });

  it("no permite mover filas entre restaurantes (UPDATE por columnas, sin restaurante_id)", () => {
    const grantsUpdate = sql.match(/grant update \([^)]*\)/gi) ?? [];
    assert.equal(grantsUpdate.length, 2);
    for (const g of grantsUpdate) assert.doesNotMatch(g, /restaurante_id/);
  });
});

describe("fotos: utilidades", () => {
  it("calcularTamano achica sin deformar y nunca agranda", () => {
    assert.deepEqual(calcularTamano(4000, 3000, 1000), { ancho: 1000, alto: 750 });
    assert.deepEqual(calcularTamano(3000, 4000, 1000), { ancho: 750, alto: 1000 });
    assert.deepEqual(calcularTamano(800, 600, 1000), { ancho: 800, alto: 600 });
    assert.deepEqual(calcularTamano(10000, 1, 1000), { ancho: 1000, alto: 1 });
    for (const malo of [[0, 10], [10, 0], [NaN, 5], [-1, 5], ["a", 5]]) {
      assert.equal(calcularTamano(...malo), null, String(malo));
    }
  });

  it("rutaDeFoto pone la foto en la carpeta del local y solo admite webp/jpeg", () => {
    const local = "00000000-0000-4000-8000-000000000001";
    assert.equal(rutaDeFoto(local, "image/webp", "abc"), `${local}/abc.webp`);
    assert.equal(rutaDeFoto(local, "image/jpeg", "abc"), `${local}/abc.jpg`);
    for (const tipo of ["image/svg+xml", "image/png", "text/html", undefined]) assert.equal(rutaDeFoto(local, tipo, "abc"), null);
  });

  it("rutaDesdeUrl solo reconoce URLs de NUESTRO bucket", () => {
    const ok = `${SUPABASE_URL}/storage/v1/object/public/menu/00000000-0000-4000-8000-000000000001/abc.webp`;
    assert.equal(rutaDesdeUrl(ok, SUPABASE_URL), "00000000-0000-4000-8000-000000000001/abc.webp");
    const malas = [
      "https://sitio-malo.com/storage/v1/object/public/menu/x/abc.webp",
      `${SUPABASE_URL}/storage/v1/object/public/otro-bucket/x/abc.webp`,
      `${SUPABASE_URL}/storage/v1/object/public/menu/../secreto.webp`,
      `${SUPABASE_URL}/storage/v1/object/public/menu/%2e%2e/secreto.webp`,
      `${SUPABASE_URL}/storage/v1/object/public/menu/`,
      "javascript:alert(1)",
      "no es url",
      null,
      42,
    ];
    for (const mala of malas) assert.equal(rutaDesdeUrl(mala, SUPABASE_URL), null, String(mala));
  });
});

describe("supabase/fotos.sql", () => {
  const sql = leer("supabase/fotos.sql").replace(/--.*$/gm, "");

  it("el bucket es público pero con límite de peso y solo webp/jpeg", () => {
    assert.ok(sql.includes("values ('menu', 'menu', true, 524288, array['image/webp', 'image/jpeg'])"));
    assert.doesNotMatch(sql, /svg|html/i);
  });

  it("subir, ver y borrar exigen ser miembro de la carpeta; no hay política de UPDATE", () => {
    const politicas = sql.match(/create policy[\s\S]*?;/gi) ?? [];
    assert.equal(politicas.length, 3);
    for (const p of politicas) {
      assert.match(p, /on storage\.objects/i);
      assert.match(p, /to authenticated/i);
      assert.ok(p.includes("bucket_id = 'menu' and public.es_miembro_de_carpeta(name)"), p);
      assert.doesNotMatch(p, /for update/i);
    }
  });

  it("la función valida el UUID antes de convertirlo, fija search_path y no es de anon", () => {
    // El CASE garantiza el orden: primero se verifica el formato, después se convierte a uuid.
    assert.match(sql, /case\s+when ruta ~\*[\s\S]*then public\.es_miembro\(split_part\(ruta, '\/', 1\)::uuid\)\s+else false/i);
    assert.match(sql, /security definer\s+set search_path = ''/i);
    assert.ok(sql.includes("revoke all on function public.es_miembro_de_carpeta(text) from public, anon"));
    assert.doesNotMatch(sql, /to\s+anon/i);
  });
});
