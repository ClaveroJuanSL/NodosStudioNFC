-- ─────────────────────────────────────────────────────────────────
-- fotos.sql — Storage para las fotos de los platos (paso 3).
--
-- Cómo aplicarlo: Supabase → SQL Editor → pegar → Run. Va DESPUÉS de
-- schema.sql y panel.sql (usa la función es_miembro()). Idempotente.
--
-- Modelo:
--   • Las fotos viven en un "bucket" público llamado "menu".
--   • Cada foto se guarda en  <id-del-restaurante>/<nombre-único>.webp
--     La carpeta es el id del local: así las políticas pueden decidir de
--     quién es cada archivo con solo mirar su ruta.
--   • PÚBLICO significa que cualquiera con el link puede VER la foto (el menú
--     la necesita). No significa que cualquiera pueda subir, borrar ni listar.
-- ─────────────────────────────────────────────────────────────────

-- ─── Bucket ──────────────────────────────────────────────────────
-- Los límites se aplican en el servidor, aunque alguien saltee el panel:
--   • 512 KB por archivo (el panel comprime a ~100-200 KB),
--   • solo WebP o JPEG (nada de SVG: puede traer scripts).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu', 'menu', true, 524288, array['image/webp', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ─── ¿Esta ruta está en la carpeta de un local mío? ──────────────
-- La primera parte de la ruta tiene que ser un UUID; recién entonces se
-- convierte. (Convertir "hola" a uuid daría error, y en un AND de SQL el
-- orden de evaluación no está garantizado; el CASE sí lo garantiza.)
create or replace function public.es_miembro_de_carpeta(ruta text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when ruta ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,100}$'
    then public.es_miembro(split_part(ruta, '/', 1)::uuid)
    else false
  end;
$$;

revoke all on function public.es_miembro_de_carpeta(text) from public, anon;
grant execute on function public.es_miembro_de_carpeta(text) to authenticated;

-- ─── Políticas sobre storage.objects ─────────────────────────────
-- (Supabase ya activó RLS en esa tabla.) Todas exigen el bucket "menu" Y que
-- la carpeta sea de un local del que el usuario es miembro.
-- No hay política de UPDATE: las fotos no se modifican, se reemplazan por
-- otra con nombre nuevo (así el navegador no muestra una foto vieja en caché).
drop policy if exists "fotos: ver las de mi local" on storage.objects;
create policy "fotos: ver las de mi local" on storage.objects
  for select to authenticated
  using (bucket_id = 'menu' and public.es_miembro_de_carpeta(name));

drop policy if exists "fotos: subir a mi local" on storage.objects;
create policy "fotos: subir a mi local" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'menu' and public.es_miembro_de_carpeta(name));

drop policy if exists "fotos: borrar las de mi local" on storage.objects;
create policy "fotos: borrar las de mi local" on storage.objects
  for delete to authenticated
  using (bucket_id = 'menu' and public.es_miembro_de_carpeta(name));
