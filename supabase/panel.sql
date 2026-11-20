-- ─────────────────────────────────────────────────────────────────
-- panel.sql — Permisos para el panel de clientes (paso 2).
--
-- Cómo aplicarlo: Supabase → SQL Editor → pegar → Run. Va DESPUÉS de
-- schema.sql. Es seguro correrlo de nuevo (idempotente).
--
-- Idea central (multi-tenant): TODOS los clientes comparten las mismas
-- tablas. Lo único que impide que el cliente A toque los datos del cliente B
-- son estas políticas RLS. Por eso la regla es siempre la misma:
--     "¿el usuario logueado es miembro de ESE restaurante?"
-- ─────────────────────────────────────────────────────────────────

-- ─── Función auxiliar: ¿soy miembro de este restaurante? ─────────
-- SECURITY DEFINER: se ejecuta con los permisos de quien la creó, así puede
-- leer "miembros" sin que la política de "miembros" se vuelva a evaluar a sí
-- misma (eso causaría una recursión infinita).
-- set search_path = '': obliga a escribir public.tabla; evita que alguien
-- cree una tabla homónima en otro esquema y la función la use por error.
-- (select auth.uid()): Postgres lo evalúa UNA vez por consulta, no por fila.
create or replace function public.es_miembro(rid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.miembros m
    where m.restaurante_id = rid
      and m.usuario_id = (select auth.uid())
  );
$$;

-- Solo los usuarios logueados pueden llamarla (anon no).
revoke all on function public.es_miembro(uuid) from public, anon;
grant execute on function public.es_miembro(uuid) to authenticated;

-- ─── miembros: cada usuario ve SOLO sus propios vínculos ─────────
drop policy if exists "panel: ver mis vinculos" on public.miembros;
create policy "panel: ver mis vinculos" on public.miembros
  for select to authenticated
  using (usuario_id = (select auth.uid()));

grant select on public.miembros to authenticated;
-- Nadie puede crear ni borrar vínculos desde la API: los vincula el dueño
-- del estudio (vos) desde el SQL Editor.

-- ─── restaurantes: los miembros ven su local aunque esté pausado ─
-- (La política pública de schema.sql solo muestra los activos.)
drop policy if exists "panel: ver mi restaurante" on public.restaurantes;
create policy "panel: ver mi restaurante" on public.restaurantes
  for select to authenticated
  using (public.es_miembro(id));
-- Todavía NO se puede modificar "restaurantes" desde el panel (logo, color,
-- etc.: paso 5). Mínimo privilegio: no se concede lo que no se usa.

-- ─── categorias ──────────────────────────────────────────────────
drop policy if exists "panel: ver mis categorias" on public.categorias;
create policy "panel: ver mis categorias" on public.categorias
  for select to authenticated
  using (public.es_miembro(restaurante_id));

drop policy if exists "panel: crear categorias" on public.categorias;
create policy "panel: crear categorias" on public.categorias
  for insert to authenticated
  with check (public.es_miembro(restaurante_id));

drop policy if exists "panel: editar categorias" on public.categorias;
create policy "panel: editar categorias" on public.categorias
  for update to authenticated
  using (public.es_miembro(restaurante_id))
  with check (public.es_miembro(restaurante_id));

drop policy if exists "panel: borrar categorias" on public.categorias;
create policy "panel: borrar categorias" on public.categorias
  for delete to authenticated
  using (public.es_miembro(restaurante_id));

-- ─── productos ───────────────────────────────────────────────────
drop policy if exists "panel: ver mis productos" on public.productos;
create policy "panel: ver mis productos" on public.productos
  for select to authenticated
  using (public.es_miembro(restaurante_id));

drop policy if exists "panel: crear productos" on public.productos;
create policy "panel: crear productos" on public.productos
  for insert to authenticated
  with check (public.es_miembro(restaurante_id));

drop policy if exists "panel: editar productos" on public.productos;
create policy "panel: editar productos" on public.productos
  for update to authenticated
  using (public.es_miembro(restaurante_id))
  with check (public.es_miembro(restaurante_id));

drop policy if exists "panel: borrar productos" on public.productos;
create policy "panel: borrar productos" on public.productos
  for delete to authenticated
  using (public.es_miembro(restaurante_id));

-- ─── Permisos de tabla (GRANT) ───────────────────────────────────
-- RLS decide QUÉ FILAS; GRANT decide QUÉ OPERACIONES y QUÉ COLUMNAS.
-- Se necesitan las dos. En UPDATE se listan las columnas editables: así
-- NADIE puede cambiar "restaurante_id" y "mudar" un plato a otro local.
grant insert, delete on public.categorias to authenticated;
grant update (nombre, orden) on public.categorias to authenticated;

grant insert, delete on public.productos to authenticated;
grant update (categoria_id, nombre, descripcion, precio, foto_url, disponible, orden)
  on public.productos to authenticated;

-- ─── Cómo vincular un usuario con un local ───────────────────────
-- 1. Supabase → Authentication → Users → "Add user" (email + contraseña,
--    marcá "Auto Confirm User"). Copiá el UUID del usuario.
-- 2. Corré esto con SU uuid y el slug del local (EJEMPLO, no se ejecuta solo):
--
--   insert into public.miembros (usuario_id, restaurante_id)
--   select 'PEGAR-UUID-DEL-USUARIO'::uuid, id
--   from public.restaurantes where slug = 'demo'
--   on conflict do nothing;
