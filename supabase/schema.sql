-- ─────────────────────────────────────────────────────────────────
-- schema.sql — Base de datos de los menús digitales (Supabase / Postgres).
--
-- Cómo aplicarlo: Supabase → SQL Editor → pegar este archivo → Run.
-- Es seguro correrlo de nuevo: usa "if not exists" y "on conflict".
--
-- ESTADO: paso 1 (menú público de solo lectura). En los pasos 2 y 4 se
-- agregan las políticas de ESCRITURA para que cada cliente edite su local.
-- ─────────────────────────────────────────────────────────────────

-- ─── Tablas ──────────────────────────────────────────────────────

create table if not exists public.restaurantes (
  id          uuid primary key default gen_random_uuid(),
  -- El slug va en la URL (/m/<slug>). Mismo formato que los slugs del Worker.
  slug        text not null unique check (slug ~ '^[a-z0-9-]{1,40}$'),
  nombre      text not null check (char_length(nombre) between 1 and 80),
  logo_url    text check (char_length(logo_url) <= 500),
  -- Color de marca en hexadecimal. La CHECK impide guardar cualquier otra
  -- cosa (el Worker lo inserta en un <style>, así que tiene que ser seguro).
  color       text not null default '#14213d' check (color ~ '^#[0-9a-fA-F]{6}$'),
  resena_url  text check (char_length(resena_url) <= 500),
  -- Solo el usuario de Instagram, sin @ ni URL.
  instagram   text check (instagram ~ '^[A-Za-z0-9._]{1,30}$'),
  -- Formato internacional sin "+": 5492664682314.
  whatsapp    text check (whatsapp ~ '^[0-9]{8,15}$'),
  -- Para "pausar" un menú (cliente que dejó de pagar) sin borrar sus datos.
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);

create table if not exists public.categorias (
  id              uuid primary key default gen_random_uuid(),
  restaurante_id  uuid not null references public.restaurantes (id) on delete cascade,
  nombre          text not null check (char_length(nombre) between 1 and 60),
  orden           integer not null default 0,
  -- Hace falta para la clave foránea compuesta de "productos" (ver abajo).
  unique (id, restaurante_id)
);

create table if not exists public.productos (
  id              uuid primary key default gen_random_uuid(),
  restaurante_id  uuid not null references public.restaurantes (id) on delete cascade,
  categoria_id    uuid not null,
  nombre          text not null check (char_length(nombre) between 1 and 120),
  descripcion     text check (char_length(descripcion) <= 300),
  precio          numeric(10, 2) not null check (precio >= 0),
  foto_url        text check (char_length(foto_url) <= 500),
  disponible      boolean not null default true,
  orden           integer not null default 0,
  -- Clave foránea COMPUESTA: la categoría tiene que pertenecer al MISMO
  -- restaurante que el producto. Sin esto, un cliente podría (por error o a
  -- propósito) colgar un plato suyo de la categoría de otro local.
  foreign key (categoria_id, restaurante_id)
    references public.categorias (id, restaurante_id) on delete cascade
);

-- Vínculo usuario ↔ restaurante (lo usan los pasos 2 y 4: login y permisos).
create table if not exists public.miembros (
  usuario_id      uuid not null references auth.users (id) on delete cascade,
  restaurante_id  uuid not null references public.restaurantes (id) on delete cascade,
  primary key (usuario_id, restaurante_id)
);

create index if not exists categorias_restaurante_idx on public.categorias (restaurante_id);
create index if not exists productos_categoria_idx    on public.productos (categoria_id);
create index if not exists productos_restaurante_idx  on public.productos (restaurante_id);
create index if not exists miembros_restaurante_idx   on public.miembros (restaurante_id);

-- ─── Row Level Security ──────────────────────────────────────────
-- Con RLS activo y SIN políticas, nadie puede leer ni escribir nada.
-- Después se agrega, política por política, lo que SÍ se permite.

alter table public.restaurantes enable row level security;
alter table public.categorias   enable row level security;
alter table public.productos    enable row level security;
alter table public.miembros     enable row level security;

-- Lectura pública: cualquiera (rol "anon", o un usuario logueado) puede ver
-- los restaurantes activos y el contenido de esos restaurantes. Nada más.
drop policy if exists "menu publico: restaurantes" on public.restaurantes;
create policy "menu publico: restaurantes" on public.restaurantes
  for select to anon, authenticated
  using (activo);

drop policy if exists "menu publico: categorias" on public.categorias;
create policy "menu publico: categorias" on public.categorias
  for select to anon, authenticated
  using (exists (
    select 1 from public.restaurantes r
    where r.id = categorias.restaurante_id and r.activo
  ));

drop policy if exists "menu publico: productos" on public.productos;
create policy "menu publico: productos" on public.productos
  for select to anon, authenticated
  using (exists (
    select 1 from public.restaurantes r
    where r.id = productos.restaurante_id and r.activo
  ));

-- "miembros" no tiene ninguna política todavía: nadie la puede leer con la
-- publishable key. Se abre en el paso 2.

-- Permisos de tabla (GRANT) además de RLS: Postgres exige las dos cosas.
-- Solo SELECT: no se concede insert/update/delete a nadie por ahora.
grant usage on schema public to anon, authenticated;
grant select on public.restaurantes, public.categorias, public.productos to anon, authenticated;

-- ─── Datos de prueba: restaurante "demo" ─────────────────────────
-- UUIDs fijos para poder volver a correr el script sin duplicar filas.

insert into public.restaurantes (id, slug, nombre, color, resena_url, instagram, whatsapp)
values (
  '00000000-0000-4000-8000-000000000001',
  'demo',
  'La Casona (demo)',
  '#b5452b',
  'https://g.page/r/DEMO/review',
  'nodosstudio',
  '5492664682314'
)
on conflict (id) do nothing;

insert into public.categorias (id, restaurante_id, nombre, orden) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Entradas', 1),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000001', 'Platos principales', 2),
  ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-000000000001', 'Bebidas', 3)
on conflict (id) do nothing;

insert into public.productos (id, restaurante_id, categoria_id, nombre, descripcion, precio, disponible, orden) values
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'Provoleta', 'Provolone a la parrilla con orégano y tomate.', 6500, true, 1),
  ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'Empanadas (unidad)', 'Carne cortada a cuchillo, pollo o jamón y queso.', 1800, true, 2),
  ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a2', 'Milanesa napolitana', 'Con papas fritas.', 14500.50, true, 1),
  ('00000000-0000-4000-8000-0000000000b4', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a2', 'Ravioles de ricota', 'Con salsa fileto o crema.', 12800, false, 2),
  ('00000000-0000-4000-8000-0000000000b5', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a3', 'Gaseosa 500 ml', null, 2500, true, 1),
  ('00000000-0000-4000-8000-0000000000b6', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a3', 'Vino de la casa (copa)', 'Malbec.', 3800, true, 2)
on conflict (id) do nothing;
