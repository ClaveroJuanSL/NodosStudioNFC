# Nodos Studio

Landing + redirector dinámico + panel de administración para las placas NFC/QR de reseñas en Google de **Nodos Studio**.

Lo que va grabado en el chip y en el QR **no** es el link de Google: es `https://TU-DOMINIO/r/<slug>`. Ese enlace redirige (302) a donde diga la base de datos, así el destino se puede cambiar sin reimprimir la placa.

## Índice

1. [Cómo funciona](#1-cómo-funciona)
2. [Qué hace cada archivo](#2-qué-hace-cada-archivo)
3. [Requisitos](#3-requisitos)
4. [Correr en local](#4-correr-en-local)
5. [Cargar el primer slug](#5-cargar-el-primer-slug)
6. [Generar placas con código de activación](#6-generar-placas-con-código-de-activación)
7. [Probar con el celular](#7-probar-con-el-celular)
8. [Tests](#8-tests)
9. [Deploy a producción, paso a paso](#9-deploy-a-producción-paso-a-paso)
10. [Checklist de seguridad antes del deploy](#10-checklist-de-seguridad-antes-del-deploy)
11. [Operación del día a día](#11-operación-del-día-a-día)
12. [Decisiones técnicas y límites conocidos](#12-decisiones-técnicas-y-límites-conocidos)
13. [Mejoras posibles](#13-mejoras-posibles)

---

## 1. Cómo funciona

```
Celular toca la placa / escanea el QR
        │  GET https://TU-DOMINIO/r/nds-00001
        ▼
┌──────────────── Worker (Cloudflare) ────────────────┐
│ 1. ¿cumple ^[a-z0-9-]{1,40}$?        no → 404       │
│ 2. KV.get("enlace:nds-00001")                       │
│ 3. según el estado:                                 │
│      activa        → 302 Location: <destino>        │
│      sin_activar   → página de activación           │
│      desactivada / no existe → 404                  │
└─────────────────────────────────────────────────────┘
        │  302 + Cache-Control: no-store
        ▼
   https://g.page/r/…/review
```

Hay dos tipos de enlace, guardados con el mismo formato en KV (`enlace:<slug>`):

| | Slug con nombre (`panaderia-lopez`) | Placa pregenerada (`nds-00001`) |
|---|---|---|
| Lo crea | vos, desde `/admin` | `npm run generar -- 50` |
| Nace | `activa`, con destino | `sin_activar`, sin destino |
| Lo edita | solo vos | vos, o el dueño del negocio con el código de su tarjeta (`/e/<id>`) |

Todo corre en **un solo Worker de Cloudflare con Static Assets**:

- Lo que está en `public/` (landing, panel, páginas) Cloudflare lo sirve directo, sin ejecutar código.
- Las rutas que no son archivos (`/r/*`, `/e/*`, `/api/*`) las atiende `src/index.js`.

## 2. Qué hace cada archivo

| Archivo | Qué hace | Por qué existe así |
|---|---|---|
| `wrangler.toml` | Configura el Worker: assets, KV, Durable Object, variables, dominio | `workers_dev = false` para que no haya una puerta trasera sin Access |
| `src/index.js` | Router + manejo global de errores + headers de seguridad | Un único lugar por donde pasa toda respuesta dinámica |
| `src/rutas/redirector.js` | `GET /r/<slug>` → 302 / activación / 404 | El destino sale solo de KV (sin open redirect) |
| `src/rutas/placas.js` | Activar y editar placas con código; página `/e/<id>` | El orden de los controles importa (ver comentarios) |
| `src/rutas/admin.js` | API del panel: listar, crear, editar, desactivar | "Borrar" = desactivar: un slug impreso nunca se reutiliza |
| `src/limitador.js` | Durable Object de rate limiting | KV no sirve para contadores (eventualmente consistente) |
| `src/lib/validacion.js` | Regex de slug, allowlist de destinos, lectura segura de JSON | "Validar, no corregir" |
| `src/lib/seguridad.js` | CSRF (Origin), token admin, JWT de Access, comparación en tiempo constante | Dos capas de autenticación que fallan cerradas |
| `src/lib/codigos.js` | Genera y verifica códigos de activación | Lo comparten el Worker y el script de lote |
| `src/lib/almacen.js` | Única puerta de entrada a KV | Patrón Repository: cambiar de base toca un solo archivo |
| `src/lib/respuestas.js` | Formato de errores, headers, servir páginas | `_headers` no cubre las respuestas del Worker |
| `public/_headers` | Headers de seguridad para los estáticos | CSP sin inline, HSTS, etc. |
| `public/index.html` + `css/` + `js/landing.js` | Landing | Mobile-first, sin frameworks, sin fuentes externas |
| `public/activar.html`, `editar.html`, `js/placa.js` | Páginas que ve el dueño del negocio | El Worker las sirve en `/r/<id>` y `/e/<id>` |
| `public/admin/*` | Panel de administración | Todo dato se muestra con `textContent` (anti-XSS) |
| `scripts/generar-placas.mjs` | Crea lotes de placas y el CSV | Primero el CSV, después KV (ver comentarios) |
| `test/*.test.js` | Tests con `node:test` | Sin dependencias extra |

## 3. Requisitos

- **Node.js 20 o superior** (`node -v`).
- Una cuenta gratuita de **Cloudflare** (solo para producción; en local no hace falta).
- Para producción: un **dominio propio** gestionado por Cloudflare. Conviene que sea corto, porque el QR queda menos denso.

La única dependencia es `wrangler`, la herramienta oficial de Cloudflare, instalada como dependencia de desarrollo.

## 4. Correr en local

```bash
npm install
```

Creá tu archivo de variables locales a partir de la plantilla (`cp` funciona en PowerShell, Git Bash, Mac y Linux):

```bash
cp .dev.vars.example .dev.vars
```

Generá un token aleatorio y pegalo en `.dev.vars` como valor de `ADMIN_TOKEN`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Levantá el servidor:

```bash
npm run dev
```

Abrí <http://localhost:8787>. `wrangler dev` simula KV y el Durable Object en `.wrangler/state`: tus datos de prueba sobreviven entre reinicios y no tocan producción.

> **Ojo con OneDrive:** si el proyecto está dentro de una carpeta sincronizada, `node_modules/` y `.wrangler/` generan miles de archivos que OneDrive intenta subir (lentitud, errores `EBUSY`). Conviene mover el repo a algo como `C:\dev\NodosStudioNFC`.

## 5. Cargar el primer slug

**Opción A: desde el panel.** Entrá a <http://localhost:8787/admin/>, pegá el `ADMIN_TOKEN` de tu `.dev.vars` y completá "Nuevo enlace":

- **Slug:** `panaderia-lopez`
- **Destino:** el link de reseñas de Google del negocio (ej. `https://g.page/r/XXXX/review`)
- **Cliente:** `Panadería López`

Probalo en <http://localhost:8787/r/panaderia-lopez>: tiene que redirigir a Google.

**Opción B: con `curl`** (útil para entender la API). En local no hay Cloudflare Access, así que alcanza con el token y el header `Origin`.

> En **Windows PowerShell** escribí `curl.exe` en lugar de `curl`: ahí `curl` es un alias de `Invoke-WebRequest` y no entiende estos parámetros. En Git Bash, Mac o Linux, `curl` funciona tal cual.

```bash
curl -X POST http://localhost:8787/api/admin/enlaces -H "Authorization: Bearer TU_TOKEN" -H "Origin: http://localhost:8787" -H "Content-Type: application/json" -d "{\"slug\":\"panaderia-lopez\",\"destino\":\"https://g.page/r/XXXX/review\",\"cliente\":\"Panadería López\"}"
```

Para ver la redirección sin seguirla (fijate en `302`, `Location` y `Cache-Control: no-store`):

```bash
curl -I http://localhost:8787/r/panaderia-lopez
```

> **Cómo conseguir el link de reseñas de un negocio:** en el Perfil de Empresa de Google, tocá **«Pedir reseñas»** y copiá el link (`https://g.page/r/…/review`).

## 6. Generar placas con código de activación

```bash
npm run generar -- 5
```

Esto crea `nds-00001` … `nds-00005` en el KV **local** y escribe `salida/placas-…csv` con las columnas `id, codigo, url, url_edicion`. Con eso armás:

- **El QR y el chip** → la columna `url` (`https://TU-DOMINIO/r/nds-00001`).
- **La tarjeta de activación** que va con la placa → el `codigo` y la `url_edicion`.

Probá el flujo completo en local:

1. Abrí <http://localhost:8787/r/nds-00001>: aparece la página de activación.
2. Ingresá el código del CSV y un link de Google. La placa queda activa.
3. Volvé a abrir `/r/nds-00001`: ahora redirige.
4. En `/e/nds-00001` podés cambiar el destino con el mismo código.
5. Equivocate 5 veces con el código de otra placa: el sexto intento devuelve "Demasiados intentos" durante una hora.

> **El CSV es el único lugar donde existen los códigos en texto plano.** En KV solo se guarda `SHA-256(sal + código)`. Guardá el CSV en un lugar seguro y borralo cuando termines de imprimir. La carpeta `salida/` está en `.gitignore`.

## 7. Probar con el celular

### Misma red Wi-Fi (lo más simple)

1. Levantá el servidor escuchando en toda la red local:
   ```bash
   npm run dev -- --ip 0.0.0.0
   ```
2. Buscá la IP de tu PC (dato "Dirección IPv4", ej. `192.168.0.15`):
   ```bash
   ipconfig
   ```
3. En el celular abrí `http://192.168.0.15:8787/r/panaderia-lopez`. Si Windows pregunta por el firewall, permití el acceso **solo en redes privadas**.

Probalo con un QR y con NFC:

- **QR:** generá un QR con esa URL (por ejemplo, desde Chrome en la PC: menú *Compartir → Crear código QR*) y escanealo con la cámara del celular.
- **NFC:** con una etiqueta NTAG213/215 y la app **NFC Tools** (Android/iOS): *Escribir → Agregar un registro → URL* → pegá la URL → *Escribir* y acercá la etiqueta. Después tocá la etiqueta con el celular bloqueado/desbloqueado para ver el comportamiento real.

> **Ojo con el admin al exponer tu PC.** `wrangler.toml` tiene `[dev] host = "localhost"`, así que en `wrangler dev` **todo** pedido le llega al Worker como si viniera de `localhost`, también desde el celular o desde un túnel. Si levantás el servidor con `--ip 0.0.0.0` o con `cloudflared`, el `/admin` local queda protegido **solo por el token** (en local no existe Cloudflare Access). Son datos de prueba, pero igual: no compartas esa URL y cerrala al terminar. En producción esto no aplica: `[dev]` solo afecta a `wrangler dev`.

### Con HTTPS desde cualquier red (opcional)

Si instalás [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/), este comando te da una URL pública `https://…trycloudflare.com` que apunta a tu PC:

```bash
cloudflared tunnel --url http://localhost:8787
```

Mientras esté abierto, **cualquiera con esa URL** llega a tu servidor local. Cerralo cuando termines.

## 8. Tests

```bash
npm test
```

Prueban, sin red ni dependencias:

- **Validación:** slugs y allowlist de destinos, con más de 15 intentos de bypass, y la lectura de JSON (tamaño, tipo, campos, UTF-8).
- **Códigos:** largo, alfabeto, distribución sin sesgo y verificación de hash.
- **Seguridad:** CSRF, token, fallar cerrado y JWT de Access firmado con claves RSA generadas en el test.
- **Headers:** que `public/_headers` y `src/lib/respuestas.js` coincidan.

## 9. Deploy a producción, paso a paso

El orden importa: **Access se configura antes del primer deploy**. Igual, si te olvidás, la API del admin falla cerrada (responde 503) hasta que lo configures.

### 9.1 Dominio en Cloudflare

1. Comprá el dominio (en Cloudflare Registrar o donde prefieras).
2. En el dashboard de Cloudflare: **Add a domain** → plan Free → cambiá los *nameservers* en tu registrador por los que te indica Cloudflare.
3. Esperá a que el dominio figure como **Active**.
4. En **SSL/TLS → Edge Certificates** activá **Always Use HTTPS**.
5. Activá la **renovación automática** del dominio. Si el dominio vence, **todas las placas impresas dejan de funcionar**, y otra persona podría comprarlo y redirigirlas a donde quiera.

### 9.2 Iniciar sesión con wrangler

```bash
npx wrangler login
```

### 9.3 Crear el namespace de KV

```bash
npx wrangler kv namespace create ENLACES
```

Copiá el `id` que devuelve y reemplazá `REEMPLAZAR_CON_EL_ID_DE_TU_KV` en `wrangler.toml`. El id no es un secreto: sin las credenciales de tu cuenta no sirve de nada.

> Al cambiar el id, `wrangler dev` empieza a usar otra base local vacía: el KV simulado se guarda en `.wrangler/state` en una carpeta **por id**. Tus datos de prueba anteriores siguen ahí, pero ya no se ven. Volvé a crearlos con `npm run generar -- 5` y desde `/admin`.

### 9.4 Proteger `/admin` con Cloudflare Access

1. En el dashboard: **Zero Trust**. La primera vez te pide un *team name*, que define tu *team domain* `TU-EQUIPO.cloudflareaccess.com`. Elegí el plan **Free**.
2. **Access → Applications → Add an application → Self-hosted**.
3. Nombre: `Nodos Admin`. Agregá **dos** destinos (*public hostnames*):
   - dominio `TU-DOMINIO`, path `admin`
   - dominio `TU-DOMINIO`, path `api/admin`
4. **Policy:** acción **Allow**, regla *Include → Emails →* tu email. Como método de login alcanza con **One-time PIN**: te llega un código por email.
5. Guardá. En la aplicación copiá el **Application Audience (AUD) Tag**.
6. Completá en `wrangler.toml`:
   ```toml
   ACCESS_TEAM_DOMAIN = "TU-EQUIPO.cloudflareaccess.com"
   ACCESS_AUD = "el-AUD-que-copiaste"
   ```

El Worker no confía ciegamente en Access: **verifica la firma del JWT** que Access agrega a cada request (`Cf-Access-Jwt-Assertion`). Por eso necesita esos dos valores.

### 9.5 Enlazar el dominio

`wrangler.toml` ya tiene la ruta de `nodosnfc.com.ar`:

```toml
routes = [
  { pattern = "nodosnfc.com.ar", custom_domain = true }
]
```

Tres cosas que conviene saber:

- **Va arriba de todo**, antes de cualquier `[sección]`. En TOML, si quedara debajo de `[vars]`, se leería como la variable `vars.routes` y el dominio no se conectaría, sin ningún error.
- **`custom_domain = true`**: Cloudflare crea solo el registro DNS y el certificado HTTPS. Requiere que el dominio esté **Active** en tu cuenta (paso 9.1); si no, `wrangler deploy` falla.
- **`[dev] host = "localhost"`**: con una ruta configurada, `wrangler dev` simula estar en `nodosnfc.com.ar` y el admin local respondería 503. Esa línea lo evita (ver sección 7).

### 9.6 Desplegar y cargar el secreto

```bash
npm test
```

```bash
npm run deploy
```

Generá un token **nuevo** (no reutilices el de `.dev.vars`), guardalo en tu gestor de contraseñas y cargalo como secreto. Wrangler te lo pide por consola y no queda en ningún archivo:

```bash
npx wrangler secret put ADMIN_TOKEN
```

### 9.7 Verificar

```bash
curl -I https://TU-DOMINIO/
```

Tiene que mostrar `content-security-policy`, `strict-transport-security`, `x-frame-options: DENY`, etc.

```bash
curl -I https://TU-DOMINIO/api/admin/enlaces
```

Tiene que responder un **302 hacia `TU-EQUIPO.cloudflareaccess.com`** (Access te frena antes de llegar al Worker).

Abrí `https://TU-DOMINIO/admin/` en una ventana de incógnito: tiene que pedir el login de Access.

### 9.8 Cargar placas en producción

```bash
npm run generar -- 50 --remoto --url-base https://TU-DOMINIO
```

El script pide que escribas `SI` antes de tocar producción.

## 10. Checklist de seguridad antes del deploy

**Secretos y repo**
- [ ] `git status` no muestra `.dev.vars` ni nada en `salida/` (`git check-ignore -v .dev.vars` confirma que está ignorado).
- [ ] No hay tokens, contraseñas ni CSV de códigos en el historial de git.
- [ ] `ADMIN_TOKEN` de producción: aleatorio, de 64 caracteres hex, distinto del local y cargado con `wrangler secret put`.

**Acceso al admin**
- [ ] `workers_dev = false` y `preview_urls = false` en `wrangler.toml`.
- [ ] Access protege `TU-DOMINIO/admin` **y** `TU-DOMINIO/api/admin`, con una política que permite solo tu email.
- [ ] `ACCESS_TEAM_DOMAIN` y `ACCESS_AUD` completos.
- [ ] En incógnito, `/admin/` pide login de Access.
- [ ] `curl -I https://TU-DOMINIO/api/admin/enlaces` redirige a `cloudflareaccess.com`.
- [ ] La cuenta de Cloudflare tiene **2FA** activado. Quien controla la cuenta controla todas las placas.

**Redirector y destinos**
- [ ] `DOMINIOS_PERMITIDOS` tiene solo hosts exactos que controla Google.
- [ ] `/r/slug-que-no-existe` da 404.
- [ ] `/r/<slug-activo>` da 302 con `Cache-Control: no-store`.
- [ ] `/r/<slug>?url=https://ejemplo.com` sigue yendo al destino guardado.

**Sitio**
- [ ] `curl -I https://TU-DOMINIO/` muestra CSP, HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy` y `X-Frame-Options`.
- [ ] La consola del navegador no muestra violaciones de CSP.
- [ ] **Always Use HTTPS** está activo.
- [ ] La renovación automática del dominio está activa.
- [ ] El número de WhatsApp está en formato internacional (`549` + área sin 0 + número sin 15, ej. `5492664682314`) y los precios son los reales.

**Proceso**
- [ ] `npm test` en verde.
- [ ] Los CSV de códigos están guardados fuera del repo o borrados.

## 11. Operación del día a día

| Tarea | Cómo |
|---|---|
| Cambiar el destino de un cliente | `/admin` → Editar, o el cliente desde `/e/<id>` con su código |
| Pausar una placa | `/admin` → Desactivar (muestra 404; se puede reactivar) |
| Ver errores en vivo | `npm run logs` (`wrangler tail`) |
| Permitir otro dominio de destino | Agregalo a `DOMINIOS_PERMITIDOS` en `wrangler.toml` y `npm run deploy` |
| Cambiar el token del admin | `npx wrangler secret put ADMIN_TOKEN` (el viejo deja de servir al instante) |
| Cambiar el número de WhatsApp | Buscá y reemplazá `5492664682314` en `public/` (formato internacional: `549` + área sin 0 + número sin 15) |

## 12. Decisiones técnicas y límites conocidos

- **302, nunca 301.** El navegador guarda los 301 sin vencimiento: un cambio de destino no le llegaría a quien ya escaneó.
- **Consistencia de KV.** KV es eventualmente consistente: un cambio de destino puede tardar hasta unos 60 segundos en verse en todo el mundo. Para un redirect está bien; para contar intentos no, por eso el rate limiting usa un Durable Object.
- **Rate limiting por ventana fija.** Son 5 fallos por placa por hora, 30 intentos por IP por hora en las placas, y en el admin 60 requests por minuto y 10 tokens incorrectos cada 15 minutos. Los límites se ajustan en `LIMITES` (`src/limitador.js`).
- **SHA-256 con sal** para los códigos. SHA-256 es rápido: si alguien obtuviera los hashes, podría probar las 887 millones de combinaciones en poco tiempo. Es aceptable porque quien puede leer tu KV también puede escribirlo, y lo que protege el código en la práctica es el límite de intentos. Ver la mejora del "pepper" más abajo.
- **IDs secuenciales** (`nds-00001`): son fáciles de leer, pero revelan cuántas placas vendiste.
- **El script de lote no admite corridas simultáneas:** dos corridas a la vez generarían los mismos IDs.
- **Los headers están en dos lugares** (`_headers` y `respuestas.js`). Un test verifica que coincidan.

## 13. Mejoras posibles

1. **Estadísticas de escaneos.** Registrar cada `/r/` con [Workers Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) (slug, país, fecha, sin guardar IPs) y mostrarlas en el panel. **No** usar KV para contar: el plan gratuito permite 1.000 escrituras por día y 1 escritura por segundo por clave.
2. **Panel para clientes.** Cada negocio entra con su email (magic link o Access) y ve sus placas, sus escaneos y puede cambiar destinos. Pide un modelo de datos relacional (`clientes`, `placas`), ideal para **D1** (SQLite de Cloudflare).
3. **QR y tarjetas automáticas.** Que el script genere un SVG del QR y un PDF imprimible de la tarjeta de activación por placa.
4. **"Pepper" secreto.** Usar `HMAC-SHA256(CODIGO_PEPPER, sal + código)` con el pepper cargado como secreto: un robo de los hashes solo no alcanzaría para probar códigos.
5. **Regenerar código desde el admin**, por si el cliente pierde la tarjeta.
6. **Registro de auditoría:** quién cambió qué destino y cuándo (el JWT de Access trae el email del admin).
7. **IDs no secuenciales** (ej. `nds-k7m2qx`) para no revelar el volumen de ventas.
8. **CI con GitHub Actions:** `npm test` en cada push y deploy automático desde `main`.
9. **Cloudflare Turnstile** en la página de activación para frenar bots sin molestar a las personas (hay que habilitar su dominio en la CSP).
10. **Backups de KV:** exportar periódicamente con `wrangler kv key list` + `get`.
11. **`og:image`, `sitemap.xml` y datos estructurados** para mejorar cómo se ve la landing al compartirla.
