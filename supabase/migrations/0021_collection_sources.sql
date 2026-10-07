-- Fontes de coleta editaveis pela tela "Onde coletar".
-- O catalogo base vive em src/data/coleta/*.json; as linhas desta tabela acrescentam fontes novas
-- ou substituem a de mesmo codigo (excluir a linha restaura a original).

create table if not exists public.collection_sources (
  code text primary key check (code ~ '^[A-Z0-9_]{2,30}$'),
  dimension text not null check (length(btrim(dimension)) > 0),
  factor text not null default '',
  name text not null check (length(btrim(name)) > 0),
  definition text not null default '',
  unit text not null default '',
  source text not null check (length(btrim(source)) > 0),
  official_link text,
  access text not null check (access in ('link', 'manual', 'local')),
  import_url text check (import_url is null or import_url ~ '^https://'),
  manual_url text check (manual_url is null or manual_url ~ '^https://'),
  steps text not null check (length(btrim(steps)) > 0),
  needs jsonb not null default '[]'::jsonb check (jsonb_typeof(needs) = 'array'),
  notes text,
  verified_on date not null default current_date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (access <> 'link' or import_url is not null)
);

alter table public.collection_sources enable row level security;

grant select, insert, update, delete on public.collection_sources to service_role;
