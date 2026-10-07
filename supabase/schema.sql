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
alter table public.import_rows add column sheet_name text;

update public.import_rows set sheet_name = 'Dados' where sheet_name is null;

alter table public.import_rows alter column sheet_name set not null;
alter table public.import_rows drop constraint if exists import_rows_import_id_row_number_key;
alter table public.import_rows add constraint import_rows_sheet_row_unique unique (import_id, sheet_name, row_number);
create index if not exists import_rows_sheet_idx on public.import_rows (import_id, sheet_name, row_number);

drop function if exists public.normalize_municipal_wide_import(uuid, text, text, integer, integer);

create function public.normalize_municipal_wide_import(
  selected_import_id uuid,
  selected_municipality_field text,
  selected_value_field text,
  selected_reference_year integer,
  selected_reference_month integer,
  selected_sheet_name text default null
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
      when trim(raw_row ->> selected_value_field) ~ '^-?[0-9]{1,3}(\.[0-9]{3})*(,[0-9]+)?$' then replace(replace(trim(raw_row ->> selected_value_field), '.', ''), ',', '.')
      when trim(raw_row ->> selected_value_field) ~ '^-?[0-9]+([,][0-9]+)?$' then replace(trim(raw_row ->> selected_value_field), ',', '.')
      else null
    end,
    'source_measure', selected_value_field
  )
  where import_id = selected_import_id
    and (selected_sheet_name is null or sheet_name = selected_sheet_name)
    and raw_row ->> selected_municipality_field ~ '^[0-9]{7}$'
    and (trim(raw_row ->> selected_value_field) ~ '^-?[0-9]{1,3}(\.[0-9]{3})*(,[0-9]+)?$'
      or trim(raw_row ->> selected_value_field) ~ '^-?[0-9]+([,][0-9]+)?$');

  get diagnostics transformed_rows = row_count;
  select count(*) into source_rows from public.import_rows where import_id = selected_import_id and (selected_sheet_name is null or sheet_name = selected_sheet_name);
  skipped_rows := source_rows - transformed_rows;
  return next;
end;
$$;

grant execute on function public.normalize_municipal_wide_import(uuid, text, text, integer, integer, text) to service_role;

drop function if exists public.approve_municipal_import(uuid, uuid, text, text, text, text);

create function public.approve_municipal_import(
  selected_import_id uuid,
  selected_indicator_id uuid,
  municipality_field text,
  year_field text,
  value_field text,
  observation_unit text,
  selected_sheet_name text default null
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
    and (selected_sheet_name is null or sheet_name = selected_sheet_name)
    and (coalesce(nullif(normalized_row ->> municipality_field, ''), raw_row ->> municipality_field) !~ '^[0-9]{7}$'
      or not exists (select 1 from municipal.municipalities where ibge_code = coalesce(nullif(normalized_row ->> municipality_field, ''), raw_row ->> municipality_field)));

  insert into municipal.observations (import_id, indicator_id, municipality_ibge_code, reference_year, reference_period, value, unit, source_row)
  select selected_import_id, selected_indicator_id, source_row ->> municipality_field, (source_row ->> year_field)::integer, coalesce((source_row ->> 'reference_period')::date, make_date((source_row ->> year_field)::integer, 1, 1)), (source_row ->> value_field)::numeric, observation_unit, source_row
  from (
    select raw_row || coalesce(normalized_row, '{}'::jsonb) as source_row
    from public.import_rows
    where import_id = selected_import_id and (selected_sheet_name is null or sheet_name = selected_sheet_name)
  ) selected_rows
  where (source_row ->> municipality_field) ~ '^[0-9]{7}$'
    and exists (select 1 from municipal.municipalities where ibge_code = source_row ->> municipality_field)
    and (source_row ->> year_field) ~ '^[0-9]{4}$'
    and (source_row ->> value_field) ~ '^-?[0-9]+([.][0-9]+)?$'
  on conflict (import_id, indicator_id, municipality_ibge_code, reference_period) where superseded_at is null do update
  set value = excluded.value, unit = excluded.unit, source_row = excluded.source_row;

  insert into core.published_values (import_id, dataset_id, indicator_code, indicator_name, dimensions, reference_period, value, unit, source_row)
  select selected_import_id, imports.dataset_id, indicators.code, indicators.name,
    jsonb_build_object('municipality_ibge_code', observations.municipality_ibge_code, 'geography_level', 'municipality'),
    observations.reference_period, observations.value, observations.unit, observations.source_row
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

grant execute on function public.approve_municipal_import(uuid, uuid, text, text, text, text, text) to service_role;
create or replace view public.dashboard_values as
select id,
  import_id,
  dataset_id,
  dataset_name,
  domain_name,
  indicator_code,
  indicator_name,
  dimensions,
  reference_period,
  value,
  unit,
  import_title,
  source_name
from core.dashboard_values;

grant select on public.dashboard_values to service_role;
do $$ begin create type core.iiu_score_direction as enum ('direct', 'inverse', 'checklist', 'manual'); exception when duplicate_object then null; end $$;

do $$ begin create type core.iiu_city_profile as enum ('pequeno', 'medio', 'grande', 'metropole'); exception when duplicate_object then null; end $$;

create table if not exists core.iiu_dimensions (code text primary key, name text not null unique, color text not null, display_order smallint not null unique check (display_order > 0), created_at timestamptz not null default now());

create table if not exists core.iiu_dimension_weights (city_profile core.iiu_city_profile not null, dimension_code text not null references core.iiu_dimensions(code) on delete restrict, weight numeric(5,2) not null check (weight > 0 and weight <= 100), primary key (city_profile, dimension_code));

alter table municipal.indicators add column if not exists iiu_dimension_code text references core.iiu_dimensions(code) on delete restrict, add column if not exists iiu_type text, add column if not exists source_description text, add column if not exists score_direction core.iiu_score_direction, add column if not exists checklist_max numeric, add column if not exists iiu_enabled boolean not null default false;

create table if not exists core.iiu_indicator_benchmarks (indicator_id uuid not null references municipal.indicators(id) on delete cascade, city_profile core.iiu_city_profile not null, minimum_value numeric not null, maximum_value numeric not null, updated_at timestamptz not null default now(), primary key (indicator_id, city_profile), check (minimum_value < maximum_value));

insert into core.iiu_dimensions (code, name, color, display_order) values ('mob', 'Mobilidade', '#3b82f6', 1) on conflict (code) do update set name = excluded.name, color = excluded.color, display_order = excluded.display_order;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('pequeno'::core.iiu_city_profile, 'mob', 10) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('medio'::core.iiu_city_profile, 'mob', 15) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('grande'::core.iiu_city_profile, 'mob', 18) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('metropole'::core.iiu_city_profile, 'mob', 20) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('cobertura_do_transporte_publico', 'Cobertura do transporte público', 'Mobilidade', '% da população a menos de 500m de ponto de transporte', '% população', 'anual', '% da população a menos de 500m de ponto de transporte', 'mob', 'Acesso', 'GTFS / OpenStreetMap', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 18, 82 from municipal.indicators where code = 'cobertura_do_transporte_publico' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 18, 82 from municipal.indicators where code = 'cobertura_do_transporte_publico' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 18, 82 from municipal.indicators where code = 'cobertura_do_transporte_publico' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 18, 82 from municipal.indicators where code = 'cobertura_do_transporte_publico' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('pontualidade_do_transporte_publico', 'Pontualidade do transporte público', 'Mobilidade', 'Viagens no horário ÷ total de viagens × 100', '% viagens no horário', 'anual', 'Viagens no horário ÷ total de viagens × 100', 'mob', 'Eficiência', 'Google Maps API / Moovit', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('infraestrutura_cicloviaria', 'Infraestrutura cicloviária', 'Mobilidade', 'Extensão total de ciclovias e ciclofaixas ÷ pop. × 100.000', 'km/100k hab.', 'anual', 'Extensão total de ciclovias e ciclofaixas ÷ pop. × 100.000', 'mob', 'Sustentabilidade', 'OpenStreetMap + campo', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('acessibilidade_universal', 'Acessibilidade universal', 'Mobilidade', 'Veículos acessíveis PCD ÷ total da frota × 100', '% frota adaptada', 'anual', 'Veículos acessíveis PCD ÷ total da frota × 100', 'mob', 'Inclusão', 'ANTT / RNVL', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('tempo_medio_de_deslocamento', 'Tempo médio de deslocamento', 'Mobilidade', 'Tempo médio diário casa→trabalho (ida e volta)', 'min/dia', 'anual', 'Tempo médio diário casa→trabalho (ida e volta)', 'mob', 'Qualidade de vida', 'IBGE Censo / PNAD', 'inverse'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 20, 95 from municipal.indicators where code = 'tempo_medio_de_deslocamento' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 20, 95 from municipal.indicators where code = 'tempo_medio_de_deslocamento' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 20, 95 from municipal.indicators where code = 'tempo_medio_de_deslocamento' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 20, 95 from municipal.indicators where code = 'tempo_medio_de_deslocamento' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('digitalizacao_do_transporte', 'Digitalização do transporte', 'Mobilidade', 'Presença de: app, pagamento digital, GPS público, bilhete único', 'índice 0–4', 'anual', 'Presença de: app, pagamento digital, GPS público, bilhete único', 'mob', 'Inovação', 'Checklist presencial', 'checklist'::core.iiu_score_direction, 4, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_dimensions (code, name, color, display_order) values ('ene', 'Energia', '#0d9488', 2) on conflict (code) do update set name = excluded.name, color = excluded.color, display_order = excluded.display_order;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('pequeno'::core.iiu_city_profile, 'ene', 18) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('medio'::core.iiu_city_profile, 'ene', 15) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('grande'::core.iiu_city_profile, 'ene', 13) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('metropole'::core.iiu_city_profile, 'ene', 12) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('participacao_de_energias_renovaveis', 'Participação de energias renováveis', 'Energia', 'Consumo renovável ÷ consumo total × 100', '% da matriz local', 'anual', 'Consumo renovável ÷ consumo total × 100', 'ene', 'Geração limpa', 'ANEEL SIGEL / BIG', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 12, 88 from municipal.indicators where code = 'participacao_de_energias_renovaveis' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 12, 88 from municipal.indicators where code = 'participacao_de_energias_renovaveis' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 12, 88 from municipal.indicators where code = 'participacao_de_energias_renovaveis' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 12, 88 from municipal.indicators where code = 'participacao_de_energias_renovaveis' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('eficiencia_da_iluminacao_publica', 'Eficiência da iluminação pública', 'Energia', 'Pontos LED com telegestão ÷ total de pontos × 100', '% pontos LED', 'anual', 'Pontos LED com telegestão ÷ total de pontos × 100', 'ene', 'Eficiência', 'ANEEL SIGA / COSIP', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('cobertura_de_coleta_seletiva', 'Cobertura de coleta seletiva', 'Energia', 'Domicílios com coleta seletiva ÷ total × 100', '% da população', 'anual', 'Domicílios com coleta seletiva ÷ total × 100', 'ene', 'Resíduos', 'SNIS Resíduos Sólidos', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('emissao_de_co2_per_capita', 'Emissão de CO₂ per capita', 'Energia', 'Total de emissões GEE municipais ÷ população', 'tCO₂/hab./ano', 'anual', 'Total de emissões GEE municipais ÷ população', 'ene', 'Clima', 'SEEG / Climate TRACE', 'inverse'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 1.2, 8.5 from municipal.indicators where code = 'emissao_de_co2_per_capita' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 1.2, 8.5 from municipal.indicators where code = 'emissao_de_co2_per_capita' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 1.2, 8.5 from municipal.indicators where code = 'emissao_de_co2_per_capita' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 1.2, 8.5 from municipal.indicators where code = 'emissao_de_co2_per_capita' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('cobertura_vegetal_urbana', 'Cobertura vegetal urbana', 'Energia', 'Área verde total (parques, praças, APP) ÷ população', 'm²/hab.', 'anual', 'Área verde total (parques, praças, APP) ÷ população', 'ene', 'Ambiente', 'MapBiomas / INPE', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('indice_de_perdas_hidricas', 'Índice de perdas hídricas', 'Energia', 'Volume perdido na distribuição ÷ volume total produzido × 100', '% do volume', 'anual', 'Volume perdido na distribuição ÷ volume total produzido × 100', 'ene', 'Água', 'SNIS Água', 'inverse'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 18, 62 from municipal.indicators where code = 'indice_de_perdas_hidricas' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 18, 62 from municipal.indicators where code = 'indice_de_perdas_hidricas' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 18, 62 from municipal.indicators where code = 'indice_de_perdas_hidricas' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 18, 62 from municipal.indicators where code = 'indice_de_perdas_hidricas' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_dimensions (code, name, color, display_order) values ('sau', 'Saúde', '#f97316', 3) on conflict (code) do update set name = excluded.name, color = excluded.color, display_order = excluded.display_order;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('pequeno'::core.iiu_city_profile, 'sau', 20) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('medio'::core.iiu_city_profile, 'sau', 18) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('grande'::core.iiu_city_profile, 'sau', 16) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('metropole'::core.iiu_city_profile, 'sau', 14) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('cobertura_da_atencao_basica_esf', 'Cobertura da atenção básica (ESF)', 'Saúde', 'Pop. coberta por equipes ESF ÷ pop. total × 100', '% da população', 'anual', 'Pop. coberta por equipes ESF ÷ pop. total × 100', 'sau', 'Acesso', 'e-Gestor AB / DAB-MS', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 35, 100 from municipal.indicators where code = 'cobertura_da_atencao_basica_esf' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 35, 100 from municipal.indicators where code = 'cobertura_da_atencao_basica_esf' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 35, 100 from municipal.indicators where code = 'cobertura_da_atencao_basica_esf' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 35, 100 from municipal.indicators where code = 'cobertura_da_atencao_basica_esf' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('leitos_hospitalares_por_habitante', 'Leitos hospitalares por habitante', 'Saúde', 'Total de leitos SUS e privados ÷ pop. × 1.000', 'leitos/1.000 hab.', 'anual', 'Total de leitos SUS e privados ÷ pop. × 1.000', 'sau', 'Capacidade', 'CNES / DATASUS', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('taxa_de_mortalidade_infantil', 'Taxa de mortalidade infantil', 'Saúde', 'Óbitos menores de 1 ano ÷ nascidos vivos × 1.000', 'por 1.000 NV', 'anual', 'Óbitos menores de 1 ano ÷ nascidos vivos × 1.000', 'sau', 'Resultado', 'SINASC + SIM / DATASUS', 'inverse'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 6, 28 from municipal.indicators where code = 'taxa_de_mortalidade_infantil' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 6, 28 from municipal.indicators where code = 'taxa_de_mortalidade_infantil' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 6, 28 from municipal.indicators where code = 'taxa_de_mortalidade_infantil' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 6, 28 from municipal.indicators where code = 'taxa_de_mortalidade_infantil' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('digitalizacao_dos_servicos_de_saude', 'Digitalização dos serviços de saúde', 'Saúde', 'Presença de: prontuário eletrônico, telemedicina, agendamento online, RNDS', 'índice 0–4', 'anual', 'Presença de: prontuário eletrônico, telemedicina, agendamento online, RNDS', 'sau', 'Tecnologia', 'Checklist RNDS / e-SUS', 'checklist'::core.iiu_score_direction, 4, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('cobertura_vacinal', 'Cobertura vacinal', 'Saúde', 'Doses aplicadas no calendário ÷ público-alvo × 100', '% do público-alvo', 'anual', 'Doses aplicadas no calendário ÷ público-alvo × 100', 'sau', 'Prevenção', 'SI-PNI / DATASUS', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 55, 99 from municipal.indicators where code = 'cobertura_vacinal' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 55, 99 from municipal.indicators where code = 'cobertura_vacinal' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 55, 99 from municipal.indicators where code = 'cobertura_vacinal' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 55, 99 from municipal.indicators where code = 'cobertura_vacinal' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('caps_por_habitante', 'CAPS por habitante', 'Saúde', 'CAPS ativos ÷ pop. × 100.000', 'unid./100k hab.', 'anual', 'CAPS ativos ÷ pop. × 100.000', 'sau', 'Saúde mental', 'CNES / DATASUS', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_dimensions (code, name, color, display_order) values ('seg', 'Segurança', '#7c3aed', 4) on conflict (code) do update set name = excluded.name, color = excluded.color, display_order = excluded.display_order;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('pequeno'::core.iiu_city_profile, 'seg', 12) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('medio'::core.iiu_city_profile, 'seg', 13) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('grande'::core.iiu_city_profile, 'seg', 15) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('metropole'::core.iiu_city_profile, 'seg', 16) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('taxa_de_homicidios', 'Taxa de homicídios', 'Segurança', 'Homicídios dolosos ÷ pop. × 100.000', 'por 100k hab.', 'anual', 'Homicídios dolosos ÷ pop. × 100.000', 'seg', 'Violência letal', 'SSP estadual / FBSP', 'inverse'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 4, 68 from municipal.indicators where code = 'taxa_de_homicidios' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 4, 68 from municipal.indicators where code = 'taxa_de_homicidios' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 4, 68 from municipal.indicators where code = 'taxa_de_homicidios' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 4, 68 from municipal.indicators where code = 'taxa_de_homicidios' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('tempo_medio_de_resposta_a_ocorrencias', 'Tempo médio de resposta a ocorrências', 'Segurança', 'Tempo entre acionamento e chegada ao local (média mensal)', 'minutos', 'anual', 'Tempo entre acionamento e chegada ao local (média mensal)', 'seg', 'Resposta', 'PM / GCM / SAMU', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('cobertura_de_videomonitoramento', 'Cobertura de videomonitoramento', 'Segurança', 'Câmeras de monitoramento ÷ área urbana em km²', 'câmeras/km²', 'anual', 'Câmeras de monitoramento ÷ área urbana em km²', 'seg', 'Tecnologia', 'Checklist presencial / PM', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('taxa_de_roubos_e_furtos', 'Taxa de roubos e furtos', 'Segurança', 'Registros de roubo + furto ÷ pop. × 100.000', 'por 100k hab.', 'anual', 'Registros de roubo + furto ÷ pop. × 100.000', 'seg', 'Patrimônio', 'SSP estadual', 'inverse'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 180, 2400 from municipal.indicators where code = 'taxa_de_roubos_e_furtos' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 180, 2400 from municipal.indicators where code = 'taxa_de_roubos_e_furtos' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 180, 2400 from municipal.indicators where code = 'taxa_de_roubos_e_furtos' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 180, 2400 from municipal.indicators where code = 'taxa_de_roubos_e_furtos' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('indice_de_policiamento_comunitario', 'Índice de policiamento comunitário', 'Segurança', 'Presença de: CONSEG ativo, base comunitária, patrulhamento a pé', 'índice 0–3', 'anual', 'Presença de: CONSEG ativo, base comunitária, patrulhamento a pé', 'seg', 'Prevenção', 'Checklist PM / GCM', 'checklist'::core.iiu_score_direction, 3, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('percepcao_de_seguranca', 'Percepção de segurança', 'Segurança', 'Nota média da população em survey sobre sensação de segurança', 'escala 0–10', 'anual', 'Nota média da população em survey sobre sensação de segurança', 'seg', 'Percepção', 'Survey próprio', 'checklist'::core.iiu_score_direction, 10, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_dimensions (code, name, color, display_order) values ('gov', 'Governança', '#d97706', 5) on conflict (code) do update set name = excluded.name, color = excluded.color, display_order = excluded.display_order;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('pequeno'::core.iiu_city_profile, 'gov', 15) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('medio'::core.iiu_city_profile, 'gov', 14) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('grande'::core.iiu_city_profile, 'gov', 14) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('metropole'::core.iiu_city_profile, 'gov', 14) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('maturidade_do_portal_de_dados_abertos', 'Maturidade do portal de dados abertos', 'Governança', 'Avaliação: existência, atualização, formatos abertos, APIs, licença', 'nível 1–5', 'anual', 'Avaliação: existência, atualização, formatos abertos, APIs, licença', 'gov', 'Transparência', 'dados.gov.br / CGU INDA', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('iegm_indice_de_efetividade_da_gestao', 'IEGM — Índice de Efetividade da Gestão', 'Governança', 'Nota oficial do TCE (i-Cidade, i-Saúde, i-Educ, i-Fiscal)', 'A a E', 'anual', 'Nota oficial do TCE (i-Cidade, i-Saúde, i-Educ, i-Fiscal)', 'gov', 'Gestão', 'TCE estadual / IRB', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('participacao_cidada_digital', 'Participação cidadã digital', 'Governança', 'Presença de: ouvidoria online, app municipal, OP digital, consultas públicas', 'índice 0–4', 'anual', 'Presença de: ouvidoria online, app municipal, OP digital, consultas públicas', 'gov', 'Participação', 'Checklist apps / ouvidoria', 'checklist'::core.iiu_score_direction, 4, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('digitalizacao_dos_servicos_publicos', 'Digitalização dos serviços públicos', 'Governança', 'Serviços realizáveis online ÷ total de serviços × 100', '% serviços online', 'anual', 'Serviços realizáveis online ÷ total de serviços × 100', 'gov', 'e-Gov', 'Portal gov.br / site municipal', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 5, 78 from municipal.indicators where code = 'digitalizacao_dos_servicos_publicos' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 5, 78 from municipal.indicators where code = 'digitalizacao_dos_servicos_publicos' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 5, 78 from municipal.indicators where code = 'digitalizacao_dos_servicos_publicos' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 5, 78 from municipal.indicators where code = 'digitalizacao_dos_servicos_publicos' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('cumprimento_da_lai', 'Cumprimento da LAI', 'Governança', 'Nota do ranking nacional de transparência ativa (CGU)', 'pontuação 0–10', 'anual', 'Nota do ranking nacional de transparência ativa (CGU)', 'gov', 'Transparência', 'CGU Ranking Transparência Ativa', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 2, 9.5 from municipal.indicators where code = 'cumprimento_da_lai' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 2, 9.5 from municipal.indicators where code = 'cumprimento_da_lai' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 2, 9.5 from municipal.indicators where code = 'cumprimento_da_lai' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 2, 9.5 from municipal.indicators where code = 'cumprimento_da_lai' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('maturidade_em_ciberseguranca', 'Maturidade em cibersegurança', 'Governança', 'LGPD implementada, backup, CSIRT, política de segurança, DPO nomeado', 'nível 1–4', 'anual', 'LGPD implementada, backup, CSIRT, política de segurança, DPO nomeado', 'gov', 'Segurança digital', 'Checklist LGPD / TI', 'checklist'::core.iiu_score_direction, 5, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_dimensions (code, name, color, display_order) values ('eco', 'Economia', '#059669', 6) on conflict (code) do update set name = excluded.name, color = excluded.color, display_order = excluded.display_order;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('pequeno'::core.iiu_city_profile, 'eco', 10) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('medio'::core.iiu_city_profile, 'eco', 12) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('grande'::core.iiu_city_profile, 'eco', 14) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('metropole'::core.iiu_city_profile, 'eco', 15) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('pib_per_capita_municipal', 'PIB per capita municipal', 'Economia', 'PIB municipal ÷ população', 'R$/hab./ano', 'anual', 'PIB municipal ÷ população', 'eco', 'Riqueza', 'IBGE PIB Municípios / SIDRA', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 8500, 72000 from municipal.indicators where code = 'pib_per_capita_municipal' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 8500, 72000 from municipal.indicators where code = 'pib_per_capita_municipal' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 8500, 72000 from municipal.indicators where code = 'pib_per_capita_municipal' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 8500, 72000 from municipal.indicators where code = 'pib_per_capita_municipal' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('taxa_de_formalizacao_do_emprego', 'Taxa de formalização do emprego', 'Economia', 'Empregos formais (RAIS) ÷ pop. ocupada × 100', '% trabalhadores formais', 'anual', 'Empregos formais (RAIS) ÷ pop. ocupada × 100', 'eco', 'Trabalho', 'RAIS / CAGED / MTE', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 28, 82 from municipal.indicators where code = 'taxa_de_formalizacao_do_emprego' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 28, 82 from municipal.indicators where code = 'taxa_de_formalizacao_do_emprego' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 28, 82 from municipal.indicators where code = 'taxa_de_formalizacao_do_emprego' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 28, 82 from municipal.indicators where code = 'taxa_de_formalizacao_do_emprego' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('densidade_de_startups_e_inovacao', 'Densidade de startups e inovação', 'Economia', 'Startups ativas + incubadoras + parques tecnológicos ÷ pop. × 100k', 'startups/100k hab.', 'anual', 'Startups ativas + incubadoras + parques tecnológicos ÷ pop. × 100k', 'eco', 'Inovação', 'Abstartups / mapeamento manual', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('cobertura_de_banda_larga', 'Cobertura de banda larga', 'Economia', 'Domicílios com banda larga fixa ÷ total × 100', '% domicílios', 'anual', 'Domicílios com banda larga fixa ÷ total × 100', 'eco', 'Conectividade', 'ANATEL / CGI.br', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 22, 91 from municipal.indicators where code = 'cobertura_de_banda_larga' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 22, 91 from municipal.indicators where code = 'cobertura_de_banda_larga' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 22, 91 from municipal.indicators where code = 'cobertura_de_banda_larga' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 22, 91 from municipal.indicators where code = 'cobertura_de_banda_larga' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('facilidade_para_abertura_de_empresas', 'Facilidade para abertura de empresas', 'Economia', 'Tempo médio para abertura de CNPJ no município (em dias)', 'dias', 'anual', 'Tempo médio para abertura de CNPJ no município (em dias)', 'eco', 'Ambiente de negócios', 'REDESIM / Junta Comercial', 'inverse'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('investimento_publico_em_inovacao', 'Investimento público em inovação', 'Economia', 'Orçamento C&T e inovação ÷ orçamento total × 100', '% do orçamento', 'anual', 'Orçamento C&T e inovação ÷ orçamento total × 100', 'eco', 'P&D', 'FINBRA / Portal Transparência', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_dimensions (code, name, color, display_order) values ('hab', 'Habitação', '#be185d', 7) on conflict (code) do update set name = excluded.name, color = excluded.color, display_order = excluded.display_order;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('pequeno'::core.iiu_city_profile, 'hab', 15) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('medio'::core.iiu_city_profile, 'hab', 13) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('grande'::core.iiu_city_profile, 'hab', 10) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into core.iiu_dimension_weights (city_profile, dimension_code, weight) values ('metropole'::core.iiu_city_profile, 'hab', 9) on conflict (city_profile, dimension_code) do update set weight = excluded.weight;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('deficit_habitacional', 'Déficit habitacional', 'Habitação', 'Déficit total ÷ total de domicílios × 100', '% dos domicílios', 'anual', 'Déficit total ÷ total de domicílios × 100', 'hab', 'Moradia', 'FJP / IBGE Censo', 'inverse'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 2, 22 from municipal.indicators where code = 'deficit_habitacional' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 2, 22 from municipal.indicators where code = 'deficit_habitacional' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 2, 22 from municipal.indicators where code = 'deficit_habitacional' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 2, 22 from municipal.indicators where code = 'deficit_habitacional' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('cobertura_de_agua_tratada', 'Cobertura de água tratada', 'Habitação', 'Pop. atendida com água tratada ÷ pop. total × 100', '% da população', 'anual', 'Pop. atendida com água tratada ÷ pop. total × 100', 'hab', 'Saneamento', 'SNIS Água / IBGE', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 55, 100 from municipal.indicators where code = 'cobertura_de_agua_tratada' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 55, 100 from municipal.indicators where code = 'cobertura_de_agua_tratada' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 55, 100 from municipal.indicators where code = 'cobertura_de_agua_tratada' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 55, 100 from municipal.indicators where code = 'cobertura_de_agua_tratada' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('cobertura_de_esgoto_sanitario', 'Cobertura de esgoto sanitário', 'Habitação', 'Pop. com coleta e tratamento de esgoto ÷ total × 100', '% da população', 'anual', 'Pop. com coleta e tratamento de esgoto ÷ total × 100', 'hab', 'Saneamento', 'SNIS Esgoto', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 22, 91 from municipal.indicators where code = 'cobertura_de_esgoto_sanitario' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 22, 91 from municipal.indicators where code = 'cobertura_de_esgoto_sanitario' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 22, 91 from municipal.indicators where code = 'cobertura_de_esgoto_sanitario' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 22, 91 from municipal.indicators where code = 'cobertura_de_esgoto_sanitario' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('populacao_em_area_de_risco', 'População em área de risco', 'Habitação', 'Habitantes em áreas de risco geológico/hídrico ÷ pop. × 100', '% da população', 'anual', 'Habitantes em áreas de risco geológico/hídrico ÷ pop. × 100', 'hab', 'Risco', 'CEMADEN / IBGE', 'inverse'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'pequeno'::core.iiu_city_profile, 0.5, 18 from municipal.indicators where code = 'populacao_em_area_de_risco' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'medio'::core.iiu_city_profile, 0.5, 18 from municipal.indicators where code = 'populacao_em_area_de_risco' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'grande'::core.iiu_city_profile, 0.5, 18 from municipal.indicators where code = 'populacao_em_area_de_risco' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value) select id, 'metropole'::core.iiu_city_profile, 0.5, 18 from municipal.indicators where code = 'populacao_em_area_de_risco' on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('indice_de_pavimentacao_viaria', 'Índice de pavimentação viária', 'Habitação', 'Vias pavimentadas ÷ extensão total de vias × 100', '% das vias', 'anual', 'Vias pavimentadas ÷ extensão total de vias × 100', 'hab', 'Infraestrutura', 'e-SIC LAI / DNIT', 'direct'::core.iiu_score_direction, null, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, iiu_dimension_code, iiu_type, source_description, score_direction, checklist_max, iiu_enabled, active) values ('maturidade_do_geoprocessamento', 'Maturidade do geoprocessamento', 'Habitação', 'Cadastro técnico, GIS municipal, PGV digital, BIM em obras', 'nível 1–4', 'anual', 'Cadastro técnico, GIS municipal, PGV digital, BIM em obras', 'hab', 'Tecnologia', 'Checklist GIS / cadastro', 'checklist'::core.iiu_score_direction, 4, true, true) on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, expected_frequency = excluded.expected_frequency, formula = excluded.formula, iiu_dimension_code = excluded.iiu_dimension_code, iiu_type = excluded.iiu_type, source_description = excluded.source_description, score_direction = excluded.score_direction, checklist_max = excluded.checklist_max, iiu_enabled = true, active = true;

create or replace view public.iiu_indicator_catalog as select indicators.id, indicators.code, indicators.name, indicators.dimension, indicators.definition, indicators.unit, indicators.expected_frequency, indicators.formula, indicators.iiu_dimension_code, indicators.iiu_type, indicators.source_description, indicators.score_direction, indicators.checklist_max, dimensions.color, dimensions.display_order from municipal.indicators indicators join core.iiu_dimensions dimensions on dimensions.code = indicators.iiu_dimension_code where indicators.iiu_enabled and indicators.active;

create or replace view public.iiu_dimension_catalog as select dimensions.code, dimensions.name, dimensions.color, dimensions.display_order, weights.city_profile, weights.weight from core.iiu_dimensions dimensions join core.iiu_dimension_weights weights on weights.dimension_code = dimensions.code;

create or replace view public.iiu_indicator_benchmark_catalog as select indicators.code as indicator_code, benchmarks.city_profile, benchmarks.minimum_value, benchmarks.maximum_value from core.iiu_indicator_benchmarks benchmarks join municipal.indicators indicators on indicators.id = benchmarks.indicator_id;

grant select on public.iiu_indicator_catalog, public.iiu_dimension_catalog, public.iiu_indicator_benchmark_catalog to service_role;

create or replace view public.iiu_municipalities as select ibge_code, name, state from municipal.municipalities;
grant select on public.iiu_municipalities to service_role;

create or replace function public.approve_municipal_import_batch(
  selected_import_id uuid,
  selected_mappings jsonb,
  selected_sheet_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, core, municipal
as $$
declare
  selected_mapping jsonb;
  selected_indicator_id uuid;
  selected_indicator_code text;
  selected_indicator_name text;
  selected_prepared_field text;
  selected_unit text;
  selected_approved_rows integer;
  approved_value_count integer := 0;
  indicator_results jsonb := '[]'::jsonb;
begin
  if selected_mappings is null or jsonb_typeof(selected_mappings) <> 'array' or jsonb_array_length(selected_mappings) < 1 or jsonb_array_length(selected_mappings) > 20 then
    raise exception 'Selecione entre 1 e 20 indicadores.' using errcode = '22023';
  end if;

  if not exists (select 1 from public.imports where id = selected_import_id) then
    raise exception 'Importacao nao encontrada.' using errcode = 'P0002';
  end if;

  if (select count(distinct mapping.value ->> 'indicator_id') from jsonb_array_elements(selected_mappings) mapping) <> jsonb_array_length(selected_mappings) then
    raise exception 'Cada indicador deve aparecer uma unica vez.' using errcode = '22023';
  end if;

  for selected_mapping in select mapping.value from jsonb_array_elements(selected_mappings) mapping
  loop
    selected_indicator_id := (selected_mapping ->> 'indicator_id')::uuid;
    selected_prepared_field := selected_mapping ->> 'prepared_field';
    selected_unit := btrim(coalesce(selected_mapping ->> 'observation_unit', ''));

    select indicators.code, indicators.name into selected_indicator_code, selected_indicator_name
    from municipal.indicators indicators
    where indicators.id = selected_indicator_id and indicators.active;

    if not found then
      raise exception 'Indicador inexistente ou inativo.' using errcode = '22023';
    end if;

    if selected_prepared_field is distinct from ('decsys_value__' || selected_indicator_code) or selected_unit = '' then
      raise exception 'Mapeamento ou unidade invalida para o indicador %.', selected_indicator_code using errcode = '22023';
    end if;

    selected_approved_rows := public.approve_municipal_import(
      selected_import_id,
      selected_indicator_id,
      'approval_municipality_ibge_code',
      'reference_year',
      selected_prepared_field,
      selected_unit,
      selected_sheet_name
    );
    approved_value_count := approved_value_count + selected_approved_rows;
    indicator_results := indicator_results || jsonb_build_array(jsonb_build_object(
      'indicator_id', selected_indicator_id,
      'indicator_code', selected_indicator_code,
      'indicator_name', selected_indicator_name,
      'approved_rows', selected_approved_rows
    ));
  end loop;

  update public.imports
  set status = case when approved_value_count > 0 then 'approved'::public.import_status else 'needs_review'::public.import_status end,
      approved_at = case when approved_value_count > 0 then now() else null end
  where id = selected_import_id;

  return jsonb_build_object(
    'import_id', selected_import_id,
    'status', case when approved_value_count > 0 then 'approved' else 'needs_review' end,
    'approved_value_count', approved_value_count,
    'indicators', indicator_results
  );
end;
$$;

revoke all on function public.approve_municipal_import_batch(uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.approve_municipal_import_batch(uuid, jsonb, text) to service_role;

-- Catálogo de indicadores da matriz de coleta da tese (7 dimensões, ECO/PES/GOV/MOB/AMB/QVI/IDD).
-- Entram fora do cálculo do IIU (iiu_enabled = false, sem dimensão/benchmark IIU): servem para classificar importações e publicar valores.
-- Idempotente: reaplicar só atualiza texto descritivo e nunca altera configuração de IIU de um indicador existente.

insert into municipal.indicators (code, name, dimension, definition, unit, expected_frequency, formula, source_description, iiu_enabled, active) values
  ('eco01_pib_municipal_per_capita', 'ECO01 — PIB municipal per capita', 'Economia', 'PIB municipal a preços correntes dividido pela população residente do mesmo ano.', 'R$/hab.', 'anual', 'PIB municipal a preços correntes dividido pela população residente do mesmo ano.', 'IBGE — PIB dos Municípios + população', false, true),
  ('eco02_participacao_do_vab_industrial_e_de_servicos', 'ECO02 — Participação do VAB industrial e de serviços', 'Economia', 'VAB da indústria e dos serviços dividido pelo VAB total municipal, por setor.', '% do VAB', 'anual', 'VAB da indústria e dos serviços dividido pelo VAB total municipal, por setor.', 'IBGE — PIB dos Municípios', false, true),
  ('eco03_densidade_de_empregos_formais', 'ECO03 — Densidade de empregos formais', 'Economia', 'Estoque de vínculos formais em 31/12 dividido pela população de 18 a 64 anos, x100.', 'vínculos/100 hab. 18–64', 'anual', 'Estoque de vínculos formais em 31/12 dividido pela população de 18 a 64 anos, x100.', 'MTE — RAIS + IBGE', false, true),
  ('eco04_remuneracao_media_do_emprego_formal', 'ECO04 — Remuneração média do emprego formal', 'Economia', 'Média da remuneração mensal dos vínculos formais; deflacionar para um ano-base em série temporal.', 'R$/mês', 'anual', 'Média da remuneração mensal dos vínculos formais; deflacionar para um ano-base em série temporal.', 'MTE — RAIS', false, true),
  ('eco05_saldo_de_empregos_formais', 'ECO05 — Saldo de empregos formais', 'Economia', 'Admissões menos desligamentos no ano, dividido pela população de 18 a 64 anos, x1.000.', 'saldo/1.000 hab. 18–64', 'anual', 'Admissões menos desligamentos no ano, dividido pela população de 18 a 64 anos, x1.000.', 'MTE — Novo Caged + IBGE', false, true),
  ('eco06_densidade_de_estabelecimentos_formais', 'ECO06 — Densidade de estabelecimentos formais', 'Economia', 'Estabelecimentos ativos na RAIS dividido pela população residente, x1.000.', 'estab./1.000 hab.', 'anual', 'Estabelecimentos ativos na RAIS dividido pela população residente, x1.000.', 'MTE — RAIS Estabelecimentos + IBGE', false, true),
  ('eco07_facilidade_para_abertura_de_empresas', 'ECO07 — Facilidade para abertura de empresas', 'Economia', 'Tempo médio para abertura de CNPJ no município.', 'dias', 'anual', 'Tempo médio para abertura de CNPJ no município.', 'REDESIM — Junta Comercial', false, true),
  ('eco08_emprego_em_setores_intensivos_em_conhecimento', 'ECO08 — Emprego em setores intensivos em conhecimento', 'Economia', 'Vínculos formais em CNAEs de alta/média-alta tecnologia ou serviços intensivos em conhecimento, divididos pelo total de vínculos.', '% dos vínculos', 'anual', 'Vínculos formais em CNAEs de alta/média-alta tecnologia ou serviços intensivos em conhecimento, divididos pelo total de vínculos.', 'MTE — RAIS por CNAE', false, true),
  ('eco09_exportacoes_municipais_per_capita', 'ECO09 — Exportações municipais per capita', 'Economia', 'Valor FOB exportado segundo o domicílio fiscal do exportador, dividido pela população.', 'US$/hab.', 'anual', 'Valor FOB exportado segundo o domicílio fiscal do exportador, dividido pela população.', 'MDIC — Comex Stat + IBGE', false, true),
  ('eco10_depositos_de_patentes_por_100_mil_habitantes', 'ECO10 — Depósitos de patentes por 100 mil habitantes', 'Economia', 'Pedidos de patente com depositante/inventor no município, dividido pela população, x100.000.', 'pedidos/100 mil hab.', 'anual', 'Pedidos de patente com depositante/inventor no município, dividido pela população, x100.000.', 'INPI — estatísticas e bases de propriedade industrial', false, true),
  ('pes01_taxa_de_alfabetizacao_da_populacao_de_14_anos_ou', 'PES01 — Taxa de alfabetização da população de 14 anos ou mais', 'Pessoas', 'Pessoas de 14+ alfabetizadas divididas pela população da mesma faixa etária.', '%', 'anual', 'Pessoas de 14+ alfabetizadas divididas pela população da mesma faixa etária.', 'IBGE — Censo Demográfico/SIDRA', false, true),
  ('pes02_populacao_de_25_anos_ou_mais_com_ensino_superior', 'PES02 — População de 25 anos ou mais com ensino superior completo', 'Pessoas', 'Pessoas de 25+ com graduação completa divididas pela população da mesma faixa etária.', '%', 'anual', 'Pessoas de 25+ com graduação completa divididas pela população da mesma faixa etária.', 'IBGE — Censo Demográfico/SIDRA', false, true),
  ('pes03_taxa_de_frequencia_escolar_de_6_a_17_anos', 'PES03 — Taxa de frequência escolar de 6 a 17 anos', 'Pessoas', 'Pessoas de 6 a 17 anos que frequentam escola divididas pela população da faixa.', '%', 'anual', 'Pessoas de 6 a 17 anos que frequentam escola divididas pela população da faixa.', 'IBGE — Censo Demográfico/SIDRA', false, true),
  ('pes04_cobertura_de_creche_para_criancas_de_0_a_3_anos', 'PES04 — Cobertura de creche para crianças de 0 a 3 anos', 'Pessoas', 'Matrículas em creche (ou crianças frequentando) divididas pela população de 0 a 3 anos.', '%', 'anual', 'Matrículas em creche (ou crianças frequentando) divididas pela população de 0 a 3 anos.', 'Inep — Censo Escolar + IBGE', false, true),
  ('pes05_ideb_anos_iniciais_do_ensino_fundamental', 'PES05 — Ideb — anos iniciais do ensino fundamental', 'Pessoas', 'Índice que combina desempenho no Saeb e fluxo escolar.', 'índice 0–10', 'anual', 'Índice que combina desempenho no Saeb e fluxo escolar.', 'Inep — Ideb', false, true),
  ('pes06_ideb_anos_finais_do_ensino_fundamental', 'PES06 — Ideb — anos finais do ensino fundamental', 'Pessoas', 'Índice que combina desempenho no Saeb e fluxo escolar.', 'índice 0–10', 'anual', 'Índice que combina desempenho no Saeb e fluxo escolar.', 'Inep — Ideb', false, true),
  ('pes07_taxa_de_distorcao_idade_serie', 'PES07 — Taxa de distorção idade-série', 'Pessoas', 'Matrículas com atraso escolar de 2+ anos divididas pelo total de matrículas da etapa.', '%', 'anual', 'Matrículas com atraso escolar de 2+ anos divididas pelo total de matrículas da etapa.', 'Inep — Indicadores Educacionais', false, true),
  ('pes08_taxa_de_aprovacao_escolar', 'PES08 — Taxa de aprovação escolar', 'Pessoas', 'Aprovados ao fim do período letivo divididos pelo total de matrículas consideradas no rendimento.', '%', 'anual', 'Aprovados ao fim do período letivo divididos pelo total de matrículas consideradas no rendimento.', 'Inep — Indicadores Educacionais', false, true),
  ('pes09_matriculas_em_eja_por_mil_adultos_sem_educacao_b', 'PES09 — Matrículas em EJA por mil adultos sem educação básica completa', 'Pessoas', 'Matrículas em EJA divididas pela população adulta sem educação básica completa, x1.000.', 'matrículas/1.000 adultos elegíveis', 'anual', 'Matrículas em EJA divididas pela população adulta sem educação básica completa, x1.000.', 'Inep — Censo Escolar + IBGE', false, true),
  ('gov01_indice_de_transparencia_ativa', 'GOV01 — Índice de transparência ativa', 'Governança', 'Pontuação do Executivo municipal no Programa Nacional de Transparência Pública.', 'índice/%', 'anual', 'Pontuação do Executivo municipal no Programa Nacional de Transparência Pública.', 'Atricon — Radar Nacional da Transparência Pública', false, true),
  ('gov02_maturidade_do_portal_de_dados_abertos', 'GOV02 — Maturidade do portal de dados abertos', 'Governança', 'Existência, atualização, formatos abertos, APIs, licença.', 'índice 0–5', 'anual', 'Existência, atualização, formatos abertos, APIs, licença.', 'CGU — Dados Abertos', false, true),
  ('gov03_capacidade_tecnica_da_administracao_municipal_pa', 'GOV03 — Capacidade técnica da administração municipal para iniciativas de cidade inteligente', 'Governança', 'Servidores efetivos com formação superior em TI, engenharia, sistemas ou afins / total de servidores efetivos x100.', '%', 'anual', 'Servidores efetivos com formação superior em TI, engenharia, sistemas ou afins / total de servidores efetivos x100.', 'RAIS / MTE', false, true),
  ('gov04_taxa_de_comparecimento_eleitoral', 'GOV04 — Taxa de comparecimento eleitoral', 'Governança', 'Eleitores que compareceram divididos pelo eleitorado apto, por eleição/turno.', '%', 'anual', 'Eleitores que compareceram divididos pelo eleitorado apto, por eleição/turno.', 'TSE — Dados Abertos', false, true),
  ('gov05_conselhos_municipais_ativos', 'GOV05 — Conselhos municipais ativos', 'Governança', 'Número ou proporção de áreas de política pública com conselho criado, paritário e com reunião no período.', 'número/índice', 'anual', 'Número ou proporção de áreas de política pública com conselho criado, paritário e com reunião no período.', 'IBGE — MUNIC + prefeitura', false, true),
  ('gov06_mecanismos_participativos_no_planejamento_e_orca', 'GOV06 — Mecanismos participativos no planejamento e orçamento', 'Governança', 'Checklist: audiência pública, consulta digital, orçamento participativo, devolutiva e publicação dos resultados.', 'índice 0–5', 'anual', 'Checklist: audiência pública, consulta digital, orçamento participativo, devolutiva e publicação dos resultados.', 'IBGE — MUNIC + portal municipal', false, true),
  ('gov07_participacao_das_receitas_proprias', 'GOV07 — Participação das receitas próprias', 'Governança', 'Receitas tributárias e demais receitas próprias divididas pela receita corrente total.', '%', 'anual', 'Receitas tributárias e demais receitas próprias divididas pela receita corrente total.', 'Tesouro Nacional — Siconfi/Finbra', false, true),
  ('gov08_despesa_de_capital_municipal_per_capita', 'GOV08 — Despesa de capital municipal per capita', 'Governança', 'Despesa de capital liquidada dividida pela população residente.', 'R$/hab.', 'anual', 'Despesa de capital liquidada dividida pela população residente.', 'Tesouro Nacional — Siconfi/Finbra + IBGE', false, true),
  ('gov09_despesa_com_pessoal_sobre_receita_corrente', 'GOV09 — Despesa com pessoal sobre receita corrente', 'Governança', 'Despesa total com pessoal dividida pela receita corrente líquida, conforme RGF.', '% da RCL', 'anual', 'Despesa total com pessoal dividida pela receita corrente líquida, conforme RGF.', 'Tesouro Nacional — Siconfi/RGF', false, true),
  ('gov10_indice_de_instrumentos_de_planejamento_vigentes', 'GOV10 — Índice de instrumentos de planejamento vigentes', 'Governança', 'Proporção de instrumentos existentes e atualizados: plano diretor, mobilidade, saneamento, resíduos, habitação, adaptação e defesa civil.', '% dos instrumentos', 'anual', 'Proporção de instrumentos existentes e atualizados: plano diretor, mobilidade, saneamento, resíduos, habitação, adaptação e defesa civil.', 'IBGE — MUNIC + legislação municipal', false, true),
  ('gov11_disponibilidade_e_desempenho_de_ouvidoria_e_sic', 'GOV11 — Disponibilidade e desempenho de ouvidoria/e-SIC', 'Governança', 'Índice composto: canal digital, acessibilidade, prazo médio de resposta e proporção respondida.', 'índice/%/dias', 'anual', 'Índice composto: canal digital, acessibilidade, prazo médio de resposta e proporção respondida.', 'PNTP + portal municipal/Fala.BR local', false, true),
  ('gov12_participacao_em_consorcios_publicos', 'GOV12 — Participação em consórcios públicos', 'Governança', 'Número de políticas/serviços executados por consórcios intermunicipais ou variável binária por área. (No PDF aparece como GOV11 duplicado.)', 'número/índice', 'anual', 'Número de políticas/serviços executados por consórcios intermunicipais ou variável binária por área. (No PDF aparece como GOV11 duplicado.)', 'IBGE — MUNIC', false, true),
  ('mob01_proporcao_de_trabalhadores_com_deslocamento_supe', 'MOB01 — Proporção de trabalhadores com deslocamento superior a 60 minutos', 'Mobilidade', 'Pessoas ocupadas com trajeto casa-trabalho > 60 min divididas pelas que se deslocam.', '%', 'anual', 'Pessoas ocupadas com trajeto casa-trabalho > 60 min divididas pelas que se deslocam.', 'IBGE — Censo Demográfico/SIDRA', false, true),
  ('mob02_participacao_dos_modos_sustentaveis_nos_deslocam', 'MOB02 — Participação dos modos sustentáveis nos deslocamentos', 'Mobilidade', 'Deslocamentos a pé, bicicleta e transporte coletivo divididos pelo total de deslocamentos casa-trabalho/estudo.', '%', 'anual', 'Deslocamentos a pé, bicicleta e transporte coletivo divididos pelo total de deslocamentos casa-trabalho/estudo.', 'IBGE — Censo + SIMU/PEMOB + pesquisa origem-destino local', false, true),
  ('mob03_taxa_de_motorizacao', 'MOB03 — Taxa de motorização', 'Mobilidade', 'Automóveis e motocicletas registrados divididos pela população, x1.000.', 'veículos/1.000 hab.', 'anual', 'Automóveis e motocicletas registrados divididos pela população, x1.000.', 'Senatran — Frota + IBGE', false, true),
  ('mob04_participacao_de_veiculos_de_baixa_emissao', 'MOB04 — Participação de veículos de baixa emissão', 'Mobilidade', 'Veículos elétricos e híbridos divididos pela frota total compatível.', '% da frota', 'anual', 'Veículos elétricos e híbridos divididos pela frota total compatível.', 'Senatran — Frota por combustível', false, true),
  ('mob05_mortalidade_no_transito', 'MOB05 — Mortalidade no trânsito', 'Mobilidade', 'Óbitos por acidentes de transporte de residentes divididos pela população, x100.000.', 'óbitos/100 mil hab.', 'anual', 'Óbitos por acidentes de transporte de residentes divididos pela população, x100.000.', 'DATASUS — SIM + IBGE', false, true),
  ('mob06_populacao_a_ate_500_m_de_ponto_estacao', 'MOB06 — População a até 500 m de ponto/estação', 'Mobilidade', 'População em setores/grade com centróide atendido por buffer de 500 m de paradas ativas.', '% da população', 'anual', 'População em setores/grade com centróide atendido por buffer de 500 m de paradas ativas.', 'GTFS municipal/operadora + IBGE geoespacial', false, true),
  ('mob07_oferta_programada_de_transporte_coletivo', 'MOB07 — Oferta programada de transporte coletivo', 'Mobilidade', 'Km-veículo programados ou partidas em dia útil divididos pela população.', 'km-veículo/hab. ou partidas/1.000 hab.', 'anual', 'Km-veículo programados ou partidas em dia útil divididos pela população.', 'GTFS/operadora municipal', false, true),
  ('mob08_extensao_da_infraestrutura_cicloviaria', 'MOB08 — Extensão da infraestrutura cicloviária', 'Mobilidade', 'Km de ciclovias, ciclofaixas e vias compartilhadas qualificadas divididos pela população, x100.000.', 'km/100 mil hab.', 'anual', 'Km de ciclovias, ciclofaixas e vias compartilhadas qualificadas divididos pela população, x100.000.', 'Prefeitura/OSM — Overpass', false, true),
  ('mob09_acessibilidade_da_frota_e_dos_pontos', 'MOB09 — Acessibilidade da frota e dos pontos', 'Mobilidade', 'Veículos e pontos de parada acessíveis divididos pelos totais operacionais.', '%', 'anual', 'Veículos e pontos de parada acessíveis divididos pelos totais operacionais.', 'Prefeitura/operadora + SIMU/PEMOB', false, true),
  ('mob10_maturidade_digital_do_transporte_coletivo', 'MOB10 — Maturidade digital do transporte coletivo', 'Mobilidade', 'Checklist: GTFS estático, tempo real, bilhetagem eletrônica/interoperável, informação ao usuário e dados abertos.', 'índice 0–5', 'anual', 'Checklist: GTFS estático, tempo real, bilhetagem eletrônica/interoperável, informação ao usuário e dados abertos.', 'Prefeitura/operadora + SIMU/PEMOB', false, true),
  ('mob11_existencia_e_implementacao_do_planmob', 'MOB11 — Existência e implementação do PlanMob', 'Mobilidade', 'Municípios > 20 mil hab. são obrigados (Lei 12.587/2012) a ter Plano de Mobilidade Urbana.', 'escala 0–2', 'anual', 'Municípios > 20 mil hab. são obrigados (Lei 12.587/2012) a ter Plano de Mobilidade Urbana.', 'Ministério das Cidades — SEMOB', false, true),
  ('amb01_cobertura_do_abastecimento_de_agua', 'AMB01 — Cobertura do abastecimento de água', 'Ambiente', 'População atendida por rede de abastecimento dividida pela população residente.', '%', 'anual', 'População atendida por rede de abastecimento dividida pela população residente.', 'Ministério das Cidades — SINISA', false, true),
  ('amb02_cobertura_da_coleta_de_esgoto', 'AMB02 — Cobertura da coleta de esgoto', 'Ambiente', 'População atendida por rede coletora dividida pela população residente.', '%', 'anual', 'População atendida por rede coletora dividida pela população residente.', 'Ministério das Cidades — SINISA', false, true),
  ('amb03_tratamento_do_esgoto_coletado', 'AMB03 — Tratamento do esgoto coletado', 'Ambiente', 'Volume de esgoto tratado dividido pelo volume coletado.', '%', 'anual', 'Volume de esgoto tratado dividido pelo volume coletado.', 'Ministério das Cidades — SINISA', false, true),
  ('amb04_indice_de_perdas_na_distribuicao', 'AMB04 — Índice de perdas na distribuição', 'Ambiente', 'Volume produzido/importado menos consumido, ajustado conforme SINISA, dividido pelo volume disponibilizado.', '%', 'anual', 'Volume produzido/importado menos consumido, ajustado conforme SINISA, dividido pelo volume disponibilizado.', 'Ministério das Cidades — SINISA', false, true),
  ('amb05_cobertura_da_coleta_domiciliar', 'AMB05 — Cobertura da coleta domiciliar', 'Ambiente', 'População atendida pela coleta regular de resíduos domiciliares dividida pela população residente.', '%', 'anual', 'População atendida pela coleta regular de resíduos domiciliares dividida pela população residente.', 'Ministério das Cidades — SINISA', false, true),
  ('amb06_cobertura_da_coleta_seletiva', 'AMB06 — Cobertura da coleta seletiva', 'Ambiente', 'População atendida por coleta seletiva porta a porta ou pontos regulares dividida pela população residente.', '%', 'anual', 'População atendida por coleta seletiva porta a porta ou pontos regulares dividida pela população residente.', 'Ministério das Cidades — SINISA', false, true),
  ('amb07_residuos_destinados_adequadamente', 'AMB07 — Resíduos destinados adequadamente', 'Ambiente', 'Massa de RSU enviada a destinação ambientalmente adequada dividida pela massa total coletada.', '% da massa', 'anual', 'Massa de RSU enviada a destinação ambientalmente adequada dividida pela massa total coletada.', 'Ministério das Cidades — SINISA', false, true),
  ('amb08_proporcao_de_vegetacao_no_territorio_municipal', 'AMB08 — Proporção de vegetação no território municipal', 'Ambiente', 'Área de vegetação natural ou cobertura arbórea dividida pela área municipal.', '% da área', 'anual', 'Área de vegetação natural ou cobertura arbórea dividida pela área municipal.', 'MapBiomas — estatísticas municipais', false, true),
  ('amb09_area_verde_urbana_per_capita', 'AMB09 — Área verde urbana per capita', 'Ambiente', 'Área de vegetação dentro do perímetro urbanizado dividida pela população urbana.', 'm²/hab. urbano', 'anual', 'Área de vegetação dentro do perímetro urbanizado dividida pela população urbana.', 'MapBiomas + perímetro municipal/IBGE', false, true),
  ('amb10_emissoes_liquidas_de_gee_per_capita', 'AMB10 — Emissões líquidas de GEE per capita', 'Ambiente', 'Emissões menos remoções de GEE no território, em CO2e, divididas pela população.', 'tCO2e/hab.', 'anual', 'Emissões menos remoções de GEE no território, em CO2e, divididas pela população.', 'SEEG Municípios + IBGE', false, true),
  ('amb11_potencia_de_micro_e_minigeracao_distribuida', 'AMB11 — Potência de micro e minigeração distribuída', 'Ambiente', 'Potência instalada de geração distribuída renovável dividida pela população, x1.000.', 'kW/1.000 hab.', 'anual', 'Potência instalada de geração distribuída renovável dividida pela população, x1.000.', 'ANEEL — dados abertos de MMGD + IBGE', false, true),
  ('amb13_ocorrencias_e_perdas_por_desastres', 'AMB13 — Ocorrências e perdas por desastres', 'Ambiente', 'Eventos reconhecidos e perdas humanas/econômicas por população ou PIB municipal. (AMB12 não existe no PDF.)', 'eventos/100 mil hab.; R$/PIB', 'anual', 'Eventos reconhecidos e perdas humanas/econômicas por população ou PIB municipal. (AMB12 não existe no PDF.)', 'MIDR — Atlas Digital de Desastres/S2iD', false, true),
  ('amb14_indice_municipal_de_risco_climatico', 'AMB14 — Índice municipal de risco climático', 'Ambiente', 'Índice de ameaça, exposição, sensibilidade e capacidade adaptativa.', 'índice/classe', 'anual', 'Índice de ameaça, exposição, sensibilidade e capacidade adaptativa.', 'MCTI — AdaptaBrasil', false, true),
  ('amb15_concentracao_anual_de_pm2_5_ou_dias_fora_do_padr', 'AMB15 — Concentração anual de PM2,5 ou dias fora do padrão', 'Ambiente', 'Média anual de PM2,5 e/ou dias acima do padrão, por estação validada ou estimativa espacial.', 'µg/m³; dias/ano', 'anual', 'Média anual de PM2,5 e/ou dias acima do padrão, por estação validada ou estimativa espacial.', 'Órgão ambiental estadual/municipal + MMA', false, true),
  ('amb16_consumo_municipal_de_energia_eletrica_per_capita', 'AMB16 — Consumo municipal de energia elétrica per capita', 'Ambiente', 'Energia elétrica faturada no município no ano dividida pela população.', 'kWh/hab./ano', 'anual', 'Energia elétrica faturada no município no ano dividida pela população.', 'Distribuidora + ANEEL — SAMP + IBGE', false, true),
  ('amb17_domicilios_com_acesso_a_energia_eletrica', 'AMB17 — Domicílios com acesso à energia elétrica', 'Ambiente', 'Domicílios particulares permanentes ocupados com energia elétrica divididos pelo total.', '% dos domicílios', 'anual', 'Domicílios particulares permanentes ocupados com energia elétrica divididos pelo total.', 'IBGE — Censo Demográfico 2022/SIDRA', false, true),
  ('amb18_potencia_centralizada_instalada_no_municipio', 'AMB18 — Potência centralizada instalada no município', 'Ambiente', 'Potência fiscalizada das usinas em operação no município dividida pela população, x100.000.', 'MW/100 mil hab.', 'anual', 'Potência fiscalizada das usinas em operação no município dividida pela população, x100.000.', 'ANEEL — SIGA + IBGE', false, true),
  ('amb19_participacao_renovavel_na_potencia_instalada', 'AMB19 — Participação renovável na potência instalada', 'Ambiente', 'Potência fiscalizada renovável em operação dividida pela potência total em operação.', '% da potência', 'anual', 'Potência fiscalizada renovável em operação dividida pela potência total em operação.', 'ANEEL — SIGA', false, true),
  ('amb20_duracao_equivalente_de_interrupcao_dec_municipal', 'AMB20 — Duração equivalente de interrupção — DEC municipal', 'Ambiente', 'Média anual de horas de interrupção por unidade consumidora, ponderada por UC.', 'horas/UC/ano', 'anual', 'Média anual de horas de interrupção por unidade consumidora, ponderada por UC.', 'ANEEL — Indicadores de Continuidade + IndQual Município', false, true),
  ('amb21_frequencia_equivalente_de_interrupcao_fec_munici', 'AMB21 — Frequência equivalente de interrupção — FEC municipal', 'Ambiente', 'Média anual do número de interrupções por unidade consumidora, ponderada por UC.', 'interrupções/UC/ano', 'anual', 'Média anual do número de interrupções por unidade consumidora, ponderada por UC.', 'ANEEL — Indicadores de Continuidade + IndQual Município', false, true),
  ('amb22_cobertura_da_tarifa_social_de_energia_eletrica', 'AMB22 — Cobertura da Tarifa Social de Energia Elétrica', 'Ambiente', 'UCs residenciais de baixa renda beneficiárias da TSEE divididas pelas famílias elegíveis no CadÚnico.', '% das famílias elegíveis', 'anual', 'UCs residenciais de baixa renda beneficiárias da TSEE divididas pelas famílias elegíveis no CadÚnico.', 'ANEEL — Beneficiários da CDE + MDS — CadÚnico', false, true),
  ('amb23_cobertura_de_iluminacao_publica_no_entorno_dos_d', 'AMB23 — Cobertura de iluminação pública no entorno dos domicílios', 'Ambiente', 'Moradores em endereços urbanos com iluminação pública na via divididos pelos moradores pesquisados.', '% dos moradores urbanos', 'anual', 'Moradores em endereços urbanos com iluminação pública na via divididos pelos moradores pesquisados.', 'IBGE — Censo 2022/Características Urbanísticas do Entorno', false, true),
  ('amb24_participacao_de_luminarias_publicas_com_tecnolog', 'AMB24 — Participação de luminárias públicas com tecnologia LED', 'Ambiente', 'Pontos de IP operacionais com LED divididos pelo total de pontos inventariados.', '% dos pontos', 'anual', 'Pontos de IP operacionais com LED divididos pelo total de pontos inventariados.', 'Prefeitura/PPP/concessionária — inventário de IP', false, true),
  ('amb25_economia_anual_dos_projetos_de_eficiencia_energe', 'AMB25 — Economia anual dos projetos de eficiência energética', 'Ambiente', 'Energia anual economizada pelos projetos de EE no município, dividida pela população.', 'kWh economizados/hab./ano', 'anual', 'Energia anual economizada pelos projetos de EE no município, dividida pela população.', 'ANEEL — Projetos de Eficiência Energética + prefeitura', false, true),
  ('qvi01_taxa_de_mortalidade_infantil', 'QVI01 — Taxa de mortalidade infantil', 'Qualidade de Vida', 'Óbitos < 1 ano divididos pelos nascidos vivos, x1.000.', 'óbitos/1.000 NV', 'anual', 'Óbitos < 1 ano divididos pelos nascidos vivos, x1.000.', 'DATASUS — SIM/SINASC', false, true),
  ('qvi02_cobertura_da_atencao_primaria_esf', 'QVI02 — Cobertura da Atenção Primária/ESF', 'Qualidade de Vida', 'População coberta pelas equipes válidas dividida pela população municipal.', '%', 'anual', 'População coberta pelas equipes válidas dividida pela população municipal.', 'Ministério da Saúde — e-Gestor APS/SISAB', false, true),
  ('qvi03_leitos_hospitalares_por_mil_habitantes', 'QVI03 — Leitos hospitalares por mil habitantes', 'Qualidade de Vida', 'Leitos ativos no CNES divididos pela população, x1.000.', 'leitos/1.000 hab.', 'anual', 'Leitos ativos no CNES divididos pela população, x1.000.', 'DATASUS — CNES + IBGE', false, true),
  ('qvi04_medicos_por_mil_habitantes', 'QVI04 — Médicos por mil habitantes', 'Qualidade de Vida', 'Médicos ativos no CNES (preferencialmente ETI) divididos pela população.', 'médicos/1.000 hab.', 'anual', 'Médicos ativos no CNES (preferencialmente ETI) divididos pela população.', 'DATASUS — CNES + IBGE', false, true),
  ('qvi05_internacoes_por_condicoes_sensiveis_a_atencao_pr', 'QVI05 — Internações por condições sensíveis à atenção primária', 'Qualidade de Vida', 'Internações por lista ICSAP divididas pela população, x10.000.', 'internações/10 mil hab.', 'anual', 'Internações por lista ICSAP divididas pela população, x10.000.', 'DATASUS — SIH/SUS + IBGE', false, true),
  ('qvi06_mortalidade_prematura_por_dcnt', 'QVI06 — Mortalidade prematura por DCNT', 'Qualidade de Vida', 'Óbitos de 30 a 69 anos por DCV, câncer, diabetes e respiratórias crônicas divididos pela população da faixa.', 'óbitos/100 mil hab. 30–69', 'anual', 'Óbitos de 30 a 69 anos por DCV, câncer, diabetes e respiratórias crônicas divididos pela população da faixa.', 'DATASUS — SIM + IBGE', false, true),
  ('qvi07_cobertura_vacinal', 'QVI07 — Cobertura vacinal', 'Qualidade de Vida', 'Doses aplicadas no calendário pelo público-alvo.', '% do público-alvo', 'anual', 'Doses aplicadas no calendário pelo público-alvo.', 'SI-PNI / DATASUS', false, true),
  ('qvi08_taxa_de_homicidios', 'QVI08 — Taxa de homicídios', 'Qualidade de Vida', 'Óbitos por agressões (CID-10) divididos pela população, x100.000.', 'óbitos/100 mil hab.', 'anual', 'Óbitos por agressões (CID-10) divididos pela população, x100.000.', 'DATASUS — SIM + Sinesp + IBGE', false, true),
  ('qvi09_indice_de_desenvolvimento_humano_municipal', 'QVI09 — Índice de Desenvolvimento Humano Municipal', 'Qualidade de Vida', 'Índice composto: longevidade, educação e renda per capita.', 'escala 0–1', 'anual', 'Índice composto: longevidade, educação e renda per capita.', 'PNUD Brasil — Atlas do Desenvolvimento Humano', false, true),
  ('qvi10_domicilios_com_inadequacao_habitacional', 'QVI10 — Domicílios com inadequação habitacional', 'Qualidade de Vida', 'Domicílios com ao menos uma inadequação: adensamento, material, sem banheiro, água, esgoto ou coleta de lixo.', '% dos domicílios', 'anual', 'Domicílios com ao menos uma inadequação: adensamento, material, sem banheiro, água, esgoto ou coleta de lixo.', 'IBGE — Censo Demográfico/SIDRA', false, true),
  ('qvi11_populacao_em_favelas_e_comunidades_urbanas', 'QVI11 — População em favelas e comunidades urbanas', 'Qualidade de Vida', 'Moradores em Favelas e Comunidades Urbanas divididos pela população municipal.', '% da população', 'anual', 'Moradores em Favelas e Comunidades Urbanas divididos pela população municipal.', 'IBGE — Censo 2022/Favelas e Comunidades Urbanas', false, true),
  ('qvi12_populacao_familias_de_baixa_renda_no_cadastro_un', 'QVI12 — População/famílias de baixa renda no Cadastro Único', 'Qualidade de Vida', 'Pessoas ou famílias inscritas nas faixas de renda selecionadas divididas pela população ou domicílios.', '%', 'anual', 'Pessoas ou famílias inscritas nas faixas de renda selecionadas divididas pela população ou domicílios.', 'MDS — CadÚnico/Relatórios de Informações', false, true),
  ('qvi13_equipamentos_culturais_por_100_mil_habitantes', 'QVI13 — Equipamentos culturais por 100 mil habitantes', 'Qualidade de Vida', 'Bibliotecas, museus, teatros, cinemas, centros culturais etc. divididos pela população.', 'equip./100 mil hab.', 'anual', 'Bibliotecas, museus, teatros, cinemas, centros culturais etc. divididos pela população.', 'IBGE — MUNIC + prefeitura', false, true),
  ('qvi14_equipamentos_publicos_de_esporte_e_lazer_por_100', 'QVI14 — Equipamentos públicos de esporte e lazer por 100 mil habitantes', 'Qualidade de Vida', 'Parques, praças qualificadas, ginásios e equipamentos esportivos públicos divididos pela população.', 'equip./100 mil hab.', 'anual', 'Parques, praças qualificadas, ginásios e equipamentos esportivos públicos divididos pela população.', 'IBGE — MUNIC + cadastro municipal', false, true),
  ('qvi15_leitos_de_hospedagem_ou_estabelecimentos_turisti', 'QVI15 — Leitos de hospedagem ou estabelecimentos turísticos por mil habitantes', 'Qualidade de Vida', 'Leitos/estabelecimentos regulares de hospedagem divididos pela população, x1.000.', 'leitos ou estab./1.000 hab.', 'anual', 'Leitos/estabelecimentos regulares de hospedagem divididos pela população, x1.000.', 'Ministério do Turismo — Cadastur + prefeitura', false, true),
  ('qvi16_deficit_habitacional_municipal_estimado', 'QVI16 — Déficit habitacional municipal estimado', 'Qualidade de Vida', 'Domicílios em habitação precária, coabitação, ônus excessivo com aluguel e adensamento excessivo de alugados, sem dupla contagem.', '% dos domicílios', 'anual', 'Domicílios em habitação precária, coabitação, ônus excessivo com aluguel e adensamento excessivo de alugados, sem dupla contagem.', 'IBGE — Censo 2022/microdados + Fundação João Pinheiro', false, true),
  ('qvi17_taxa_de_domicilios_vagos', 'QVI17 — Taxa de domicílios vagos', 'Qualidade de Vida', 'Domicílios particulares permanentes vagos divididos pelo total (ocupados, vagos e de uso ocasional).', '% dos domicílios', 'anual', 'Domicílios particulares permanentes vagos divididos pelo total (ocupados, vagos e de uso ocasional).', 'IBGE — Censo Demográfico 2022/SIDRA', false, true),
  ('qvi18_domicilios_proprios_ocupados', 'QVI18 — Domicílios próprios ocupados', 'Qualidade de Vida', 'Domicílios ocupados próprios (quitados ou em aquisição) divididos pelo total de ocupados.', '% dos domicílios ocupados', 'anual', 'Domicílios ocupados próprios (quitados ou em aquisição) divididos pelo total de ocupados.', 'IBGE — Censo Demográfico 2022/SIDRA', false, true),
  ('qvi19_onus_excessivo_com_aluguel_urbano', 'QVI19 — Ônus excessivo com aluguel urbano', 'Qualidade de Vida', 'Domicílios urbanos alugados de baixa renda com aluguel > 30% da renda divididos pelos alugados de baixa renda.', '% dos domicílios-alvo', 'anual', 'Domicílios urbanos alugados de baixa renda com aluguel > 30% da renda divididos pelos alugados de baixa renda.', 'IBGE — Censo 2022/microdados + Fundação João Pinheiro', false, true),
  ('qvi20_adensamento_excessivo_em_domicilios_alugados', 'QVI20 — Adensamento excessivo em domicílios alugados', 'Qualidade de Vida', 'Domicílios alugados com mais de 3 moradores por dormitório divididos pelo total de alugados.', '% dos domicílios alugados', 'anual', 'Domicílios alugados com mais de 3 moradores por dormitório divididos pelo total de alugados.', 'IBGE — Censo 2022/microdados + Fundação João Pinheiro', false, true),
  ('qvi21_domicilios_improvisados_ou_rusticos', 'QVI21 — Domicílios improvisados ou rústicos', 'Qualidade de Vida', 'Domicílios ocupados improvisados ou com materiais rústicos/inadequados divididos pelos ocupados.', '% dos domicílios ocupados', 'anual', 'Domicílios ocupados improvisados ou com materiais rústicos/inadequados divididos pelos ocupados.', 'IBGE — Censo Demográfico 2022/SIDRA', false, true),
  ('qvi22_domicilios_ou_populacao_em_areas_de_alto_e_muito', 'QVI22 — Domicílios ou população em áreas de alto e muito alto risco geológico', 'Qualidade de Vida', 'Domicílios/população em setores de risco alto e muito alto divididos pelo total municipal (sobreposição geoespacial).', '% dos domicílios ou moradores', 'anual', 'Domicílios/população em setores de risco alto e muito alto divididos pelo total municipal (sobreposição geoespacial).', 'SGB — Cartografia de Riscos Geológicos + IBGE/prefeitura', false, true),
  ('qvi23_unidades_habitacionais_do_mcmv_contratadas_ou_co', 'QVI23 — Unidades habitacionais do MCMV contratadas ou concluídas', 'Qualidade de Vida', 'UH do MCMV no município por situação, divididas por 1.000 domicílios ou pelo déficit habitacional.', 'UH/1.000 domicílios; % do déficit', 'anual', 'UH do MCMV no município por situação, divididas por 1.000 domicílios ou pelo déficit habitacional.', 'Ministério das Cidades — Bases do Minha Casa, Minha Vida', false, true),
  ('qvi24_regularidade_municipal_no_snhis', 'QVI24 — Regularidade municipal no SNHIS', 'Qualidade de Vida', 'Situação no SNHIS, complementada por fundo, conselho e plano local de habitação vigentes.', 'binário/índice 0–4', 'anual', 'Situação no SNHIS, complementada por fundo, conselho e plano local de habitação vigentes.', 'Ministério das Cidades — SNHIS + IBGE MUNIC/legislação municipal', false, true),
  ('idd01_acessos_de_banda_larga_fixa_por_100_domicilios', 'IDD01 — Acessos de banda larga fixa por 100 domicílios', 'Infraestrutura Digital e Dados', 'Acessos ativos de SCM divididos pelos domicílios particulares, x100.', 'acessos/100 domicílios', 'anual', 'Acessos ativos de SCM divididos pelos domicílios particulares, x100.', 'Anatel — dados abertos + IBGE', false, true),
  ('idd02_participacao_de_acessos_em_fibra_optica', 'IDD02 — Participação de acessos em fibra óptica', 'Infraestrutura Digital e Dados', 'Acessos de banda larga fixa em fibra divididos pelo total de acessos fixos.', '% dos acessos', 'anual', 'Acessos de banda larga fixa em fibra divididos pelo total de acessos fixos.', 'Anatel — dados abertos', false, true),
  ('idd03_cobertura_populacional_4g_ou_5g', 'IDD03 — Cobertura populacional 4G ou 5G', 'Infraestrutura Digital e Dados', 'Moradores em áreas com cobertura 4G/5G divididos pela população municipal.', '% da população', 'anual', 'Moradores em áreas com cobertura 4G/5G divididos pela população municipal.', 'Anatel — Painel de Cobertura Móvel', false, true),
  ('idd04_estacoes_radio_base_por_100_mil_habitantes', 'IDD04 — Estações rádio-base por 100 mil habitantes', 'Infraestrutura Digital e Dados', 'ERBs licenciadas e ativas divididas pela população, x100.000.', 'ERBs/100 mil hab.', 'anual', 'ERBs licenciadas e ativas divididas pela população, x100.000.', 'Anatel — dados abertos', false, true),
  ('idd05_infraestrutura_de_sensores_inteligentes_instalad', 'IDD05 — Infraestrutura de sensores inteligentes instalada', 'Infraestrutura Digital e Dados', 'Existência de sensoriamento urbano em tempo real: tráfego, ar, água/energia, câmeras inteligentes, sensores de inundação.', 'escala 0–4', 'anual', 'Existência de sensoriamento urbano em tempo real: tráfego, ar, água/energia, câmeras inteligentes, sensores de inundação.', 'IBGE — MUNIC (TI) / relatórios municipais', false, true),
  ('idd06_pontos_publicos_de_wi_fi_por_100_mil_habitantes', 'IDD06 — Pontos públicos de Wi-Fi por 100 mil habitantes', 'Infraestrutura Digital e Dados', 'Pontos públicos gratuitos operacionais divididos pela população, x100.000.', 'pontos/100 mil hab.', 'anual', 'Pontos públicos gratuitos operacionais divididos pela população, x100.000.', 'Prefeitura/programas públicos', false, true),
  ('idd07_servicos_municipais_totalmente_digitais', 'IDD07 — Serviços municipais totalmente digitais', 'Infraestrutura Digital e Dados', 'Serviços prioritários solicitados, acompanhados e concluídos on-line divididos pelo total avaliado.', '% dos serviços', 'anual', 'Serviços prioritários solicitados, acompanhados e concluídos on-line divididos pelo total avaliado.', 'Portal municipal + IBGE MUNIC', false, true),
  ('idd08_maturidade_do_portal_de_dados_abertos', 'IDD08 — Maturidade do portal de dados abertos', 'Infraestrutura Digital e Dados', 'Checklist: catálogo, licença, formatos abertos, metadados, atualização, API, histórico e canal de contato.', 'índice 0–8', 'anual', 'Checklist: catálogo, licença, formatos abertos, metadados, atualização, API, histórico e canal de contato.', 'Portal municipal + PNTP', false, true),
  ('idd09_integracao_da_plataforma_urbana_de_dados', 'IDD09 — Integração da plataforma urbana de dados', 'Infraestrutura Digital e Dados', 'Índice de sistemas prioritários integrados por identificadores, padrões de dados e APIs documentadas.', 'índice/%', 'anual', 'Índice de sistemas prioritários integrados por identificadores, padrões de dados e APIs documentadas.', 'Prefeitura/arquitetura de TIC', false, true),
  ('idd10_maturidade_de_seguranca_da_informacao_e_lgpd', 'IDD10 — Maturidade de segurança da informação e LGPD', 'Infraestrutura Digital e Dados', 'Checklist: política, encarregado, inventário, controle de acesso, backups, resposta a incidentes, treinamento e transparência.', 'índice 0–8', 'anual', 'Checklist: política, encarregado, inventário, controle de acesso, backups, resposta a incidentes, treinamento e transparência.', 'Prefeitura/portal institucional', false, true),
  ('idd11_escolas_com_internet_adequada', 'IDD11 — Escolas com internet adequada', 'Infraestrutura Digital e Dados', 'Escolas com internet e parâmetros mínimos divididas pelo total de escolas.', '% das escolas', 'anual', 'Escolas com internet e parâmetros mínimos divididas pelo total de escolas.', 'Inep — Censo Escolar', false, true),
  ('idd12_estabelecimentos_de_saude_com_conectividade_sist', 'IDD12 — Estabelecimentos de saúde com conectividade/sistemas digitais', 'Infraestrutura Digital e Dados', 'Estabelecimentos com conexão e sistemas digitais divididos pelo total selecionado.', '% dos estabelecimentos', 'anual', 'Estabelecimentos com conexão e sistemas digitais divididos pelo total selecionado.', 'DATASUS/CNES + levantamento municipal', false, true)
on conflict (code) do update set name = excluded.name, dimension = excluded.dimension, definition = excluded.definition, unit = excluded.unit, formula = excluded.formula, source_description = excluded.source_description;

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
