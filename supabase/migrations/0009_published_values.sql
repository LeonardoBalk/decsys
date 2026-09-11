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


