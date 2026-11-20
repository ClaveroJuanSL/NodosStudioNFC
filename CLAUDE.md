# Nodos Studio (nodosnfc.com.ar)

Emprendimiento de Juan (estudiante de Tecnicatura en Desarrollo de Software): placas con chip NFC + QR para negocios (reseñas de Google) y desarrollo de webs. **Hablar siempre en español.** Modo profesor: explicar el porqué de cada decisión, pasos chicos, mostrar el plan antes de cambios grandes.

## Reglas de trabajo
- Pedir confirmación antes de instalar paquetes o cambiar la config de deploy (`wrangler.toml`).
- No romper las páginas actuales (landing, `/admin`, `/r/*`, `/e/*`).
- Nunca commitear `.dev.vars`, `salida/` (CSV con códigos en texto plano) ni secretos.

## Stack real (NO es Next.js)
- **Cloudflare Worker + Static Assets**, JavaScript ESM puro, sin framework ni build.
- Dependencias: `wrangler` (dev) y `@supabase/supabase-js` (instalada para el panel del paso 2; el Worker NO la usa, `/m/*` va por `fetch`). Para el navegador se copia `node_modules/@supabase/supabase-js/dist/umd/supabase.js` a `public/` (la CSP exige `script-src 'self'`). Node >= 20.
- `public/`: sitio estático (landing, `admin/`, `activar.html`, `editar.html`, `_headers`).
- `src/index.js`: router; `src/rutas/{redirector,placas,admin}.js`; `src/lib/*` (validación, seguridad, almacén KV, respuestas); `src/limitador.js` (Durable Object de rate limiting).
- Datos: **KV** (`ENLACES`, claves `enlace:<slug>`). Rate limit: Durable Object `LIMITADOR`.
- `/admin` protegido por **Cloudflare Access** (JWT verificado en el Worker) + `ADMIN_TOKEN`.
- Detalle completo de arquitectura, seguridad y operación: `README.md`.

## Cómo correr en local
```
npm install
npm run dev        # http://localhost:8787 (KV y DO simulados en .wrangler/)
npm test           # 39 tests, node:test
npm run generar -- 5   # crea placas nds-00001.. y CSV en salida/
```
Requiere `.dev.vars` (ignorado por git) con `ENTORNO=local` y `ADMIN_TOKEN` de 32+ caracteres. `.dev.vars.example` NO está en el repo (README lo menciona pero falta).

## Cómo desplegar
Deploy directo con wrangler (el repo NO está conectado a Cloudflare):
```
npx wrangler login          # una vez por PC
npm test && npm run deploy
npx wrangler secret put ADMIN_TOKEN   # solo si cambia el secreto
```
- Dominio `nodosnfc.com.ar` comprado en NIC.ar, DNS delegado en Cloudflare; ruta `custom_domain = true` en `wrangler.toml`.
- `workers_dev = false` y `preview_urls = false` a propósito (si no, se saltearía Access).
- Variables públicas en `[vars]`; secretos solo con `wrangler secret put`.

## Decisiones tomadas
- El chip/QR lleva `https://nodosnfc.com.ar/r/<slug>`, que hace **302** (nunca 301) al destino guardado en KV: se puede cambiar sin reimprimir.
- "Borrar" = desactivar: un slug impreso nunca se reutiliza.
- Destinos solo de `DOMINIOS_PERMITIDOS` (coincidencia exacta de host).
- Headers de seguridad duplicados en `public/_headers` y `src/lib/respuestas.js` (un test verifica que coincidan).
- Rate limiting con Durable Object (KV no sirve para contadores).

## Estado (nov 2026)
- PC formateada; proyecto recuperado desde GitHub (`origin` = ClaveroJuanSL/NodosStudioNFC, rama `main`).
- Falta tras formatear: `npx wrangler login` (no hay sesión).

## Menú digital: paso 1 hecho (código listo, falta conectar Supabase real)
- `supabase/schema.sql`: tablas `restaurantes`, `categorias`, `productos`, `miembros`; RLS activo; lectura pública solo de restaurantes activos; restaurante de prueba `demo`. Se aplica a mano en Supabase → SQL Editor.
- `src/rutas/menu.js` (`GET /m/<slug>`): lee Supabase por `fetch` (REST/PostgREST, header `apikey` con la publishable key; sin paquete npm), caché de Cloudflare 2 min, 404 cacheado 1 min.
- `src/lib/menu.js`: render HTML puro; todo se escapa; imágenes solo del Storage público del proyecto; color solo `#rrggbb`.
- CSP propia en `/m/*` (sin scripts; `<style>` inline autorizado por hash; `img-src` = host de Supabase). La CSP global NO se tocó.
- `wrangler.toml` `[vars]`: `SUPABASE_URL` (proyecto `safhlmjqpzwyyazjjzqb`) y `SUPABASE_PUBLISHABLE_KEY` ya completas (son públicas por diseño). Si quedan vacías, `/m/*` da 503. Nunca poner la secret/service_role key.
- Schema ya aplicado en Supabase y verificado: lectura pública OK, `miembros` cerrada, escritura anónima rechazada. `/m/demo` probado en local contra Supabase real.
- Tests: `test/menu.test.js` (Supabase simulado). Total 60.

## Menú digital: paso 2 hecho (código listo; falta aplicar SQL y crear usuario de prueba)
- Panel en `/panel/` (público, SIN Cloudflare Access; `/admin` sigue siendo solo del dueño): `public/panel/{index.html,panel.js,panel.css,config.js,utiles.js}`. Login email+contraseña con `supabase-js` en el navegador; CRUD de categorías y platos, precio, "no disponible". Sin `innerHTML`: todo con `textContent`.
- `public/vendor/supabase.js` = copia del build UMD de supabase-js (CSP exige `script-src 'self'`). Regenerar con `npm run vendor` tras actualizar el paquete y commitear.
- `public/_headers`: regla `/panel/*` con `! Content-Security-Policy` (desacopla la global) + CSP propia con `connect-src` al host de Supabase. Debe ir DESPUÉS de `/*`. La CSP global no se tocó.
- `supabase/panel.sql` (aplicar en SQL Editor tras schema.sql): función `es_miembro(rid)` (security definer, search_path vacío) y políticas por miembro para categorias/productos; UPDATE solo por columnas (no se puede cambiar `restaurante_id`); `miembros` solo lectura de lo propio; `restaurantes` NO editable aún (paso 5).
- Las cuentas de clientes las crea el dueño en Supabase → Auth → Users (registro público desactivado) y las vincula con un INSERT en `miembros` (ejemplo al final de panel.sql).
- `SUPABASE_URL` y la publishable key viven en 3 lugares (`wrangler.toml`, `public/panel/config.js`, CSP en `_headers`); `test/panel.test.js` verifica que coincidan.
- wrangler actualizado a 4.165.0 (0 vulnerabilidades en `npm audit`). Los avisos de npm sobre scripts de `esbuild`/`workerd` se dejan sin aprobar a propósito. Tests: 74.
- Pendiente de probar con un usuario real: CRUD completo y aislamiento entre dos locales (paso 4).

## Menú digital: paso 3 hecho (código listo; falta aplicar fotos.sql y probar una subida real)
- `supabase/fotos.sql` (aplicar tras panel.sql): bucket PÚBLICO `menu` (512 KB máx, solo webp/jpeg) + políticas en `storage.objects` (ver/subir/borrar solo en la carpeta de un local propio, vía `es_miembro_de_carpeta(name)`; sin UPDATE). Ruta: `<id-del-local>/<uuid>.webp`. Público = cualquiera VE la foto por su link; no puede listar ni escribir.
- Panel: el navegador comprime (canvas, máx 1000 px, WebP→JPEG, borra EXIF/GPS) antes de subir. Orden: subir foto → guardar plato; si falla el guardado se borra la foto; al reemplazar/quitar/borrar se borra la vieja (mejor esfuerzo). Probado en navegador: 1329 KB (4000×3000) → 117 KB (1000×750). Se rechazan SVG, texto e imágenes corruptas.
- CSP de `/panel/*`: `img-src 'self' <host supabase> blob:` (blob: para la vista previa). `/m/*` ya aceptaba imágenes de ese Storage.
- Pendiente: subir una foto real con sesión y verla en `/m/<slug>`; foto_url no se valida contra la carpeta del propio local (un miembro podría apuntar a la foto de otro; bajo impacto, evaluar en paso 4). Tests: 80.
- Si `npm` falla en PowerShell por la política de ejecución, usar `npm.cmd` (no se cambió ninguna configuración de Windows).

## Objetivo en curso: menú digital multi-cliente (pasos 4–5 pendientes; "más estilo" del menú público va en el paso 5)
`/m/<slug>` público (mobile-first, categorías → platos, botón reseña/Instagram/WhatsApp, logo y color por cliente) + panel con login por cliente (CRUD, fotos, "no disponible"). Backend Supabase (Auth + Postgres + Storage, RLS por `restaurante_id`). Lectura en tiempo de visita con caché corta, no en build. Orden: (1) BD + menú público con datos de prueba, (2) login y panel CRUD, (3) subida de imágenes comprimidas, (4) RLS, (5) personalización. Pendiente decidir cómo integrar con este Worker (ver resumen del Paso 0).
