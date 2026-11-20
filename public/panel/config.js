// Datos PÚBLICOS del proyecto de Supabase, que necesita el navegador.
// No son secretos: la publishable key está pensada para ir en el código del
// navegador porque lo que protege los datos es RLS (ver supabase/*.sql).
//
// NUNCA pongas acá la "secret key" ni la "service_role": se saltean RLS.
//
// Estos valores se repiten en wrangler.toml y public/_headers;
// test/panel.test.js falla si no coinciden.
export const SUPABASE_URL = "https://safhlmjqpzwyyazjjzqb.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_GjiPEPJB_ghWe_xJku5rFw_9CQsRie0";
