// Copia el build de supabase-js para el NAVEGADOR a public/vendor/.
//
// ¿Por qué copiarlo? La CSP del sitio solo permite scripts de este mismo
// dominio ('self'): no se puede cargar desde un CDN. Y no hay "build", así
// que copiamos el archivo ya empaquetado (UMD) que trae el paquete npm.
//
// Se corre con `npm run vendor` después de actualizar @supabase/supabase-js.
// El resultado se commitea (public/vendor/supabase.js).

import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const origen = join(raiz, "node_modules/@supabase/supabase-js/dist/umd/supabase.js");
const destino = join(raiz, "public/vendor/supabase.js");

const { version } = JSON.parse(readFileSync(join(raiz, "node_modules/@supabase/supabase-js/package.json"), "utf8"));

mkdirSync(dirname(destino), { recursive: true });
copyFileSync(origen, destino);
console.log(`supabase-js ${version} copiado a public/vendor/supabase.js`);
