create schema if not exists core;
create schema if not exists municipal;

create table core.projects (
  project_id uuid primary key default gen_random_uuid(),
  project_name text not null unique,
  project_description text,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table core.domains (
  domain_id uuid primary key default gen_random_uuid(),
  project_id uuid not null references core.projects(project_id) on delete restrict,
  domain_name text not null,
  domain_description text,
  created_at timestamptz not null default now(),
  unique (project_id, domain_name)
);

create table core.datasets (
  dataset_id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references core.domains(domain_id) on delete restrict,
  dataset_name text not null,
  dataset_description text,
  data_schema text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  unique (domain_id, dataset_name)
);

alter table public.imports add column dataset_id uuid references core.datasets(dataset_id) on delete restrict;

create index imports_dataset_idx on public.imports (dataset_id);
create index domains_project_idx on core.domains (project_id);
create index datasets_domain_idx on core.datasets (domain_id);

alter table public.municipalities set schema municipal;
alter table public.indicators set schema municipal;
alter table public.observations set schema municipal;

alter table core.projects enable row level security;
alter table core.domains enable row level security;
alter table core.datasets enable row level security;

create policy "authenticated users may read projects" on core.projects for select to authenticated using (true);
create policy "authenticated users may read domains" on core.domains for select to authenticated using (true);
create policy "authenticated users may read datasets" on core.datasets for select to authenticated using (true);

grant usage on schema core, municipal to authenticated;
grant select on all tables in schema core, municipal to authenticated;
