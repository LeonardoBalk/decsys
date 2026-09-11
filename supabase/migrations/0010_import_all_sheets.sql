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
