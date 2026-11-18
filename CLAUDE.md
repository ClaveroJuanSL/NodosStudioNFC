# Nodos Studio (nodosnfc.com.ar)

Emprendimiento de Juan (estudiante de Tecnicatura en Desarrollo de Software): placas con chip NFC + QR para negocios (reseñas de Google) y desarrollo de webs. **Hablar siempre en español.** Modo profesor: explicar el porqué de cada decisión, pasos chicos, mostrar el plan antes de cambios grandes.

## Reglas de trabajo
- Pedir confirmación antes de instalar paquetes o cambiar la config de deploy (`wrangler.toml`).
- No romper las páginas actuales (landing, `/admin`, `/r/*`, `/e/*`).
- Nunca commitear `.dev.vars`, `salida/` (CSV con códigos en texto plano) ni secretos.

## Stack real (NO es Next.js)
- **Cloudflare Worker + Static Assets**, JavaScript ESM puro, sin framework ni build.
- Única dependencia: `wrangler` (devDependency). Node >= 20.
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
- `wrangler.toml` `[vars]`: `SUPABASE_URL` y `SUPABASE_PUBLISHABLE_KEY` están VACÍAS → `/m/*` da 503 hasta completarlas. Nunca poner la secret/service_role key.
- Tests: `test/menu.test.js` (Supabase simulado). Total 60.

## Objetivo en curso: menú digital multi-cliente (pasos 2–5 pendientes)
`/m/<slug>` público (mobile-first, categorías → platos, botón reseña/Instagram/WhatsApp, logo y color por cliente) + panel con login por cliente (CRUD, fotos, "no disponible"). Backend Supabase (Auth + Postgres + Storage, RLS por `restaurante_id`). Lectura en tiempo de visita con caché corta, no en build. Orden: (1) BD + menú público con datos de prueba, (2) login y panel CRUD, (3) subida de imágenes comprimidas, (4) RLS, (5) personalización. Pendiente decidir cómo integrar con este Worker (ver resumen del Paso 0).
