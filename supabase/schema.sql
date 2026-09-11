create extension if not exists pgcrypto;

create type public.import_status as enum ('draft', 'analyzing', 'needs_review', 'approved', 'archived', 'discarded');
create type public.validation_severity as enum ('info', 'warning', 'error');

create table public.municipalities (
  ibge_code text primary key check (ibge_code ~ '^[0-9]{7}$'),
  name text not null,
  state char(2) not null check (state ~ '^[A-Z]{2}$'),
  created_at timestamptz not null default now()
);

create table public.indicators (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  dimension text not null,
  definition text not null,
  unit text not null,
  expected_frequency text,
  formula text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  publisher text,
  base_url text,
  trust_level smallint not null default 2 check (trust_level between 1 and 3),
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.sources(id) on delete restrict,
  title text not null,
  reference_year integer,
  source_url text,
  storage_path text,
  file_name text,
  file_sha256 text,
  status public.import_status not null default 'draft',
  imported_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.treatment_proposals (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete cascade,
  target_indicator_id uuid references public.indicators(id) on delete restrict,
  mapping jsonb not null default '{}'::jsonb,
  calculation jsonb not null default '{}'::jsonb,
  explanation text not null,
  confidence numeric(4,3) check (confidence between 0 and 1),
  created_at timestamptz not null default now()
);

create table public.validation_issues (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete cascade,
  severity public.validation_severity not null,
  row_number integer,
  field text,
  message text not null,
  created_at timestamptz not null default now()
);

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete restrict,
  indicator_id uuid not null references public.indicators(id) on delete restrict,
  municipality_ibge_code text not null references public.municipalities(ibge_code) on delete restrict,
  reference_year integer not null check (reference_year between 1900 and 2200),
  value numeric,
  unit text not null,
  numerator numeric,
  denominator numeric,
  source_row jsonb not null default '{}'::jsonb,
  notes text,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index observations_active_unique
  on public.observations (import_id, indicator_id, municipality_ibge_code, reference_year)
  where superseded_at is null;
create index observations_indicator_year_idx on public.observations (indicator_id, reference_year);
create index observations_municipality_idx on public.observations (municipality_ibge_code);
create index observations_import_idx on public.observations (import_id);
create index imports_source_idx on public.imports (source_id);
create index imports_status_idx on public.imports (status);
create index treatment_proposals_import_idx on public.treatment_proposals (import_id);
create index validation_issues_import_idx on public.validation_issues (import_id);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger imports_set_updated_at
before update on public.imports
for each row execute function public.set_updated_at();

alter table public.municipalities enable row level security;
alter table public.indicators enable row level security;
alter table public.sources enable row level security;
alter table public.imports enable row level security;
alter table public.treatment_proposals enable row level security;
alter table public.validation_issues enable row level security;
alter table public.observations enable row level security;

create policy "authenticated users may read workspace data" on public.municipalities for select to authenticated using (true);
create policy "authenticated users may read indicators" on public.indicators for select to authenticated using (true);
create policy "authenticated users may read sources" on public.sources for select to authenticated using (true);
create policy "authenticated users may read imports" on public.imports for select to authenticated using (true);
create policy "authenticated users may read proposals" on public.treatment_proposals for select to authenticated using (true);
create policy "authenticated users may read validation issues" on public.validation_issues for select to authenticated using (true);
create policy "authenticated users may read observations" on public.observations for select to authenticated using (true);

insert into storage.buckets (id, name, public) values ('source-files', 'source-files', false)
on conflict (id) do nothing;
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
grant usage on schema public, core, municipal to service_role;
grant all privileges on all tables in schema public, core, municipal to service_role;
grant usage, select on all sequences in schema public, core, municipal to service_role;
grant execute on all functions in schema public, core, municipal to service_role;

alter default privileges for role postgres in schema public grant all privileges on tables to service_role;
alter default privileges for role postgres in schema core grant all privileges on tables to service_role;
alter default privileges for role postgres in schema municipal grant all privileges on tables to service_role;
alter default privileges for role postgres in schema public grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema core grant usage, select on sequences to service_role;
alter default privileges for role postgres in schema municipal grant usage, select on sequences to service_role;
alter table public.imports
  add column profile jsonb not null default '{}'::jsonb,
  add column processed_storage_path text,
  add column total_rows integer not null default 0 check (total_rows >= 0);

create table public.import_rows (
  id bigint generated always as identity primary key,
  import_id uuid not null references public.imports(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  raw_row jsonb not null,
  normalized_row jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (import_id, row_number)
);

create index import_rows_import_idx on public.import_rows (import_id, row_number);

alter table public.import_rows enable row level security;

create policy "authenticated users may read staged import rows" on public.import_rows
  for select to authenticated using (true);

grant all privileges on public.import_rows to service_role;
grant usage, select on sequence public.import_rows_id_seq to service_role;
create or replace function public.approve_municipal_import(
  selected_import_id uuid,
  selected_indicator_id uuid,
  municipality_field text,
  year_field text,
  value_field text,
  observation_unit text
)
returns integer
language plpgsql
security definer
set search_path = public, municipal
as $$
declare
  approved_rows integer;
begin
  insert into public.validation_issues (import_id, severity, row_number, field, message)
  select selected_import_id, 'error', row_number, municipality_field, 'Código IBGE inválido ou município inexistente.'
  from public.import_rows
  where import_id = selected_import_id
    and ((raw_row ->> municipality_field) !~ '^[0-9]{7}$' or not exists (select 1 from municipal.municipalities where ibge_code = raw_row ->> municipality_field));

  insert into municipal.observations (import_id, indicator_id, municipality_ibge_code, reference_year, value, unit, source_row)
  select selected_import_id, selected_indicator_id, raw_row ->> municipality_field, (raw_row ->> year_field)::integer, (raw_row ->> value_field)::numeric, observation_unit, raw_row
  from public.import_rows
  where import_id = selected_import_id
    and (raw_row ->> municipality_field) ~ '^[0-9]{7}$'
    and exists (select 1 from municipal.municipalities where ibge_code = raw_row ->> municipality_field)
    and (raw_row ->> year_field) ~ '^[0-9]{4}$'
    and (raw_row ->> value_field) ~ '^-?[0-9]+([.,][0-9]+)?$'
  on conflict (import_id, indicator_id, municipality_ibge_code, reference_year) where superseded_at is null do update
  set value = excluded.value, unit = excluded.unit, source_row = excluded.source_row;

  get diagnostics approved_rows = row_count;
  update public.imports set status = 'approved', approved_at = now() where id = selected_import_id;
  return approved_rows;
end;
$$;

grant execute on function public.approve_municipal_import(uuid, uuid, text, text, text, text) to service_role;
create or replace function public.approve_generic_import(
  selected_import_id uuid,
  selected_mapping jsonb,
  selected_explanation text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  proposal_id uuid;
begin
  insert into public.treatment_proposals (import_id, mapping, explanation, confidence)
  values (selected_import_id, selected_mapping, selected_explanation, 1)
  returning id into proposal_id;

  update public.imports
  set status = 'approved', approved_at = now()
  where id = selected_import_id;

  return proposal_id;
end;
$$;

grant execute on function public.approve_generic_import(uuid, jsonb, text) to service_role;
create or replace function public.list_active_indicators()
returns table (id uuid, code text, name text, unit text)
language sql
stable
security definer
set search_path = public, municipal
as $$
  select id, code, name, unit from municipal.indicators where active order by name;
$$;

grant execute on function public.list_active_indicators() to service_role;
create table public.import_sheets (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete cascade,
  sheet_name text not null,
  sheet_position integer not null check (sheet_position > 0),
  row_count integer not null default 0 check (row_count >= 0),
  column_count integer not null default 0 check (column_count >= 0),
  columns_profile jsonb not null default '[]'::jsonb,
  sample_rows jsonb not null default '[]'::jsonb,
  selected_for_treatment boolean not null default false,
  created_at timestamptz not null default now(),
  unique (import_id, sheet_name)
);

create index import_sheets_import_idx on public.import_sheets (import_id, sheet_position);

alter table public.import_sheets enable row level security;
create policy "authenticated users may read import sheets" on public.import_sheets for select to authenticated using (true);
grant all privileges on public.import_sheets to service_role;

alter table municipal.observations add column reference_period date;

update municipal.observations
set reference_period = make_date(reference_year, 1, 1)
where reference_period is null;

alter table municipal.observations alter column reference_period set not null;

drop index if exists municipal.observations_active_unique;

create unique index observations_active_period_unique
  on municipal.observations (import_id, indicator_id, municipality_ibge_code, reference_period)
  where superseded_at is null;

create index observations_indicator_period_idx on municipal.observations (indicator_id, reference_period);

create table core.published_values (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete restrict,
  dataset_id uuid references core.datasets(dataset_id) on delete restrict,
  indicator_code text not null,
  indicator_name text not null,
  dimensions jsonb not null default '{}'::jsonb,
  reference_period date not null,
  value numeric,
  unit text not null,
  source_row jsonb not null default '{}'::jsonb,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index published_values_active_unique
  on core.published_values (import_id, indicator_code, reference_period, (dimensions ->> 'municipality_ibge_code'))
  where superseded_at is null;

create index published_values_dataset_idx on core.published_values (dataset_id, reference_period);
create index published_values_indicator_idx on core.published_values (indicator_code, reference_period);

alter table core.published_values enable row level security;

create policy "authenticated users may read published values" on core.published_values
  for select to authenticated using (true);

grant all privileges on core.published_values to service_role;

create or replace function public.normalize_municipal_wide_import(
  selected_import_id uuid,
  selected_municipality_field text,
  selected_value_field text,
  selected_reference_year integer,
  selected_reference_month integer
)
returns table (transformed_rows integer, skipped_rows integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  source_rows integer;
begin
  update public.import_rows
  set normalized_row = jsonb_build_object(
    'municipality_ibge_code', raw_row ->> selected_municipality_field,
    'reference_year', selected_reference_year::text,
    'reference_period', make_date(selected_reference_year, selected_reference_month, 1)::text,
    'value', case
      when trim(raw_row ->> selected_value_field) ~ '^-?[0-9]{1,3}(\\.[0-9]{3})*(,[0-9]+)?$' then replace(replace(trim(raw_row ->> selected_value_field), '.', ''), ',', '.')
      when trim(raw_row ->> selected_value_field) ~ '^-?[0-9]+([,][0-9]+)?$' then replace(trim(raw_row ->> selected_value_field), ',', '.')
      else null
    end,
    'source_measure', selected_value_field
  )
  where import_id = selected_import_id
    and raw_row ->> selected_municipality_field ~ '^[0-9]{7}$'
    and (trim(raw_row ->> selected_value_field) ~ '^-?[0-9]{1,3}(\\.[0-9]{3})*(,[0-9]+)?$'
      or trim(raw_row ->> selected_value_field) ~ '^-?[0-9]+([,][0-9]+)?$');

  get diagnostics transformed_rows = row_count;

  select count(*) into source_rows from public.import_rows where import_id = selected_import_id;
  skipped_rows := source_rows - transformed_rows;
  return next;
end;
$$;

grant execute on function public.normalize_municipal_wide_import(uuid, text, text, integer, integer) to service_role;

create or replace function public.approve_municipal_import(
  selected_import_id uuid,
  selected_indicator_id uuid,
  municipality_field text,
  year_field text,
  value_field text,
  observation_unit text
)
returns integer
language plpgsql
security definer
set search_path = public, core, municipal
as $$
declare
  approved_rows integer;
begin
  insert into public.validation_issues (import_id, severity, row_number, field, message)
  select selected_import_id, 'error', row_number, municipality_field, 'Código IBGE inválido ou município inexistente.'
  from public.import_rows
  where import_id = selected_import_id
    and (coalesce(nullif(normalized_row ->> municipality_field, ''), raw_row ->> municipality_field) !~ '^[0-9]{7}$'
      or not exists (select 1 from municipal.municipalities where ibge_code = coalesce(nullif(normalized_row ->> municipality_field, ''), raw_row ->> municipality_field)));

  insert into municipal.observations (import_id, indicator_id, municipality_ibge_code, reference_year, reference_period, value, unit, source_row)
  select selected_import_id,
    selected_indicator_id,
    source_row ->> municipality_field,
    (source_row ->> year_field)::integer,
    coalesce((source_row ->> 'reference_period')::date, make_date((source_row ->> year_field)::integer, 1, 1)),
    (source_row ->> value_field)::numeric,
    observation_unit,
    source_row
  from (
    select raw_row || coalesce(normalized_row, '{}'::jsonb) as source_row
    from public.import_rows
    where import_id = selected_import_id
  ) selected_rows
  where (source_row ->> municipality_field) ~ '^[0-9]{7}$'
    and exists (select 1 from municipal.municipalities where ibge_code = source_row ->> municipality_field)
    and (source_row ->> year_field) ~ '^[0-9]{4}$'
    and (source_row ->> value_field) ~ '^-?[0-9]+([.][0-9]+)?$'
  on conflict (import_id, indicator_id, municipality_ibge_code, reference_period) where superseded_at is null do update
  set value = excluded.value, unit = excluded.unit, source_row = excluded.source_row;

  insert into core.published_values (import_id, dataset_id, indicator_code, indicator_name, dimensions, reference_period, value, unit, source_row)
  select selected_import_id,
    imports.dataset_id,
    indicators.code,
    indicators.name,
    jsonb_build_object('municipality_ibge_code', observations.municipality_ibge_code, 'geography_level', 'municipality'),
    observations.reference_period,
    observations.value,
    observations.unit,
    observations.source_row
  from municipal.observations observations
  join public.imports imports on imports.id = observations.import_id
  join municipal.indicators indicators on indicators.id = observations.indicator_id
  where observations.import_id = selected_import_id
    and observations.indicator_id = selected_indicator_id
    and observations.superseded_at is null
  on conflict (import_id, indicator_code, reference_period, (dimensions ->> 'municipality_ibge_code')) where superseded_at is null do update
  set value = excluded.value, unit = excluded.unit, source_row = excluded.source_row;

  get diagnostics approved_rows = row_count;
  update public.imports set status = 'approved', approved_at = now() where id = selected_import_id;
  return approved_rows;
end;
$$;

grant execute on function public.approve_municipal_import(uuid, uuid, text, text, text, text) to service_role;

create or replace view core.dashboard_values as
select published_values.id,
  published_values.import_id,
  published_values.dataset_id,
  datasets.dataset_name,
  domains.domain_name,
  published_values.indicator_code,
  published_values.indicator_name,
  published_values.dimensions,
  published_values.reference_period,
  published_values.value,
  published_values.unit,
  imports.title as import_title,
  sources.name as source_name
from core.published_values published_values
left join core.datasets datasets on datasets.dataset_id = published_values.dataset_id
left join core.domains domains on domains.domain_id = datasets.domain_id
join public.imports imports on imports.id = published_values.import_id
join public.sources sources on sources.id = imports.source_id
where published_values.superseded_at is null
  and imports.status = 'approved'
  and imports.archived_at is null;

grant select on core.dashboard_values to authenticated, service_role;
