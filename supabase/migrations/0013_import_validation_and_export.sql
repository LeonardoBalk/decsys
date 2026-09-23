create or replace function public.normalize_municipal_wide_import(
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
  if selected_reference_year not between 1900 and 2200 or selected_reference_month not between 1 and 12 then
    raise exception 'Período de referência inválido.';
  end if;

  update public.import_rows
  set normalized_row = '{}'::jsonb
  where import_id = selected_import_id
    and (selected_sheet_name is null or sheet_name = selected_sheet_name);

  update public.import_rows
  set normalized_row = jsonb_build_object(
    'municipality_ibge_code', raw_row ->> selected_municipality_field,
    'reference_year', selected_reference_year::text,
    'reference_period', make_date(selected_reference_year, selected_reference_month, 1)::text,
    'value', case
      when trim(raw_row ->> selected_value_field) ~ '^-?[0-9]{1,3}(\.[0-9]{3})+(,[0-9]+)?$'
        or trim(raw_row ->> selected_value_field) ~ '^-?[0-9]+,[0-9]+$'
        then replace(replace(trim(raw_row ->> selected_value_field), '.', ''), ',', '.')
      when trim(raw_row ->> selected_value_field) ~ '^-?[0-9]+(\.[0-9]+)?$'
        then trim(raw_row ->> selected_value_field)
      else null
    end,
    'source_measure', selected_value_field
  )
  where import_id = selected_import_id
    and (selected_sheet_name is null or sheet_name = selected_sheet_name)
    and raw_row ->> selected_municipality_field ~ '^[0-9]{7}$'
    and (trim(raw_row ->> selected_value_field) ~ '^-?[0-9]{1,3}(\.[0-9]{3})+(,[0-9]+)?$'
      or trim(raw_row ->> selected_value_field) ~ '^-?[0-9]+,[0-9]+$'
      or trim(raw_row ->> selected_value_field) ~ '^-?[0-9]+(\.[0-9]+)?$');

  get diagnostics transformed_rows = row_count;
  select count(*) into source_rows
  from public.import_rows
  where import_id = selected_import_id
    and (selected_sheet_name is null or sheet_name = selected_sheet_name);
  skipped_rows := source_rows - transformed_rows;
  return next;
end;
$$;

grant execute on function public.normalize_municipal_wide_import(uuid, text, text, integer, integer, text) to service_role;

create or replace function public.approve_municipal_import(
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
  delete from public.validation_issues
  where import_id = selected_import_id
    and field in (municipality_field, year_field, value_field)
    and left(message, 4) = 'Aba '
    and (selected_sheet_name is null or left(message, length(format('Aba "%s": ', selected_sheet_name))) = format('Aba "%s": ', selected_sheet_name));

  update municipal.observations
  set superseded_at = now()
  where import_id = selected_import_id
    and indicator_id = selected_indicator_id
    and superseded_at is null
    and (selected_sheet_name is null or coalesce(source_row ->> 'source_sheet', '') in ('', selected_sheet_name));

  with staged_values as (
    select import_rows.row_number,
      import_rows.sheet_name,
      import_rows.raw_row || coalesce(import_rows.normalized_row, '{}'::jsonb) as source_row
    from public.import_rows
    where import_rows.import_id = selected_import_id
      and (selected_sheet_name is null or import_rows.sheet_name = selected_sheet_name)
  ), checked_values as (
    select staged_values.row_number,
      staged_values.sheet_name,
      staged_values.source_row,
      btrim(coalesce(staged_values.source_row ->> municipality_field, '')) as municipality_code,
      btrim(coalesce(staged_values.source_row ->> year_field, '')) as year_text,
      btrim(coalesce(staged_values.source_row ->> value_field, '')) as value_text,
      (btrim(coalesce(staged_values.source_row ->> municipality_field, '')) ~ '^[0-9]{7}$'
        and exists (select 1 from municipal.municipalities where ibge_code = btrim(staged_values.source_row ->> municipality_field))) as valid_municipality,
      case when btrim(coalesce(staged_values.source_row ->> year_field, '')) ~ '^[0-9]{4}([.]0+)?$'
        then regexp_replace(btrim(staged_values.source_row ->> year_field), '[.]0+$', '')::integer between 1900 and 2200
        else false
      end as valid_year,
      (length(btrim(coalesce(staged_values.source_row ->> value_field, ''))) <= 64
        and btrim(coalesce(staged_values.source_row ->> value_field, '')) ~ '^-?[0-9]+([.][0-9]+)?$') as valid_value
    from staged_values
  ), complete_values as (
    select checked_values.*,
      case when valid_year then regexp_replace(year_text, '[.]0+$', '')::integer end as reference_year,
      case when source_row ->> 'reference_period' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-01$'
        then (source_row ->> 'reference_period')::date
        when valid_year then make_date(regexp_replace(year_text, '[.]0+$', '')::integer, 1, 1)
      end as reference_period,
      case when valid_municipality and valid_year and valid_value
        then count(*) filter (where valid_municipality and valid_year and valid_value) over (
          partition by municipality_code,
            case when valid_year then regexp_replace(year_text, '[.]0+$', '')::integer end,
            coalesce(source_row ->> 'reference_period', '')
        )
        else 0
      end as duplicate_count
    from checked_values
  )
  insert into public.validation_issues (import_id, severity, row_number, field, message)
  select selected_import_id, 'error', complete_values.row_number, invalid_values.field,
    format('Aba "%s": %s', complete_values.sheet_name, invalid_values.message)
  from complete_values
  cross join lateral (values
    (municipality_field, not valid_municipality, 'Código IBGE inválido ou município inexistente.'),
    (year_field, not valid_year, 'Ano inválido. Informe um ano entre 1900 e 2200.'),
    (value_field, not valid_value, 'Valor inválido. Informe um número com ponto decimal ou converta o formato brasileiro antes da gravação.'),
    (municipality_field, duplicate_count > 1, 'Mais de uma linha deste arquivo informa valor para o mesmo município e período; nenhuma delas foi gravada.'),
    (municipality_field, valid_municipality and valid_year and valid_value and exists (
      select 1 from municipal.observations existing_observation
      where existing_observation.import_id = selected_import_id
        and existing_observation.indicator_id = selected_indicator_id
        and existing_observation.municipality_ibge_code = complete_values.municipality_code
        and existing_observation.reference_period = complete_values.reference_period
        and existing_observation.superseded_at is null
        and coalesce(existing_observation.source_row ->> 'source_sheet', '') <> coalesce(complete_values.sheet_name, '')
    ), 'Outra aba deste arquivo já informa um valor para o mesmo município e período; escolha uma única linha de origem.')
  ) as invalid_values(field, has_error, message)
  where invalid_values.has_error
    and not exists (
      select 1
      from public.validation_issues existing_issue
      where existing_issue.import_id = selected_import_id
        and existing_issue.row_number = complete_values.row_number
        and existing_issue.field = invalid_values.field
        and existing_issue.message = format('Aba "%s": %s', complete_values.sheet_name, invalid_values.message)
    );

  with staged_values as (
    select import_rows.row_number,
      import_rows.sheet_name,
      import_rows.raw_row || coalesce(import_rows.normalized_row, '{}'::jsonb) as source_row
    from public.import_rows
    where import_rows.import_id = selected_import_id
      and (selected_sheet_name is null or import_rows.sheet_name = selected_sheet_name)
  ), checked_values as (
    select staged_values.row_number,
      staged_values.sheet_name,
      staged_values.source_row,
      btrim(coalesce(staged_values.source_row ->> municipality_field, '')) as municipality_code,
      btrim(coalesce(staged_values.source_row ->> year_field, '')) as year_text,
      btrim(coalesce(staged_values.source_row ->> value_field, '')) as value_text,
      (btrim(coalesce(staged_values.source_row ->> municipality_field, '')) ~ '^[0-9]{7}$'
        and exists (select 1 from municipal.municipalities where ibge_code = btrim(staged_values.source_row ->> municipality_field))) as valid_municipality,
      case when btrim(coalesce(staged_values.source_row ->> year_field, '')) ~ '^[0-9]{4}([.]0+)?$'
        then regexp_replace(btrim(staged_values.source_row ->> year_field), '[.]0+$', '')::integer between 1900 and 2200
        else false
      end as valid_year,
      (length(btrim(coalesce(staged_values.source_row ->> value_field, ''))) <= 64
        and btrim(coalesce(staged_values.source_row ->> value_field, '')) ~ '^-?[0-9]+([.][0-9]+)?$') as valid_value
    from staged_values
  ), complete_values as (
    select checked_values.*,
      case when valid_year then regexp_replace(year_text, '[.]0+$', '')::integer end as reference_year,
      case when source_row ->> 'reference_period' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-01$'
        then (source_row ->> 'reference_period')::date
        else make_date(regexp_replace(year_text, '[.]0+$', '')::integer, 1, 1)
      end as reference_period,
      count(*) over (
        partition by municipality_code,
          case when valid_year then regexp_replace(year_text, '[.]0+$', '')::integer end,
          coalesce(source_row ->> 'reference_period', '')
      ) as duplicate_count
    from checked_values
    where valid_municipality and valid_year and valid_value
  )
  insert into municipal.observations (import_id, indicator_id, municipality_ibge_code, reference_year, reference_period, value, unit, source_row)
  select selected_import_id,
    selected_indicator_id,
    municipality_code,
    reference_year,
    reference_period,
    value_text::numeric,
    observation_unit,
    source_row || jsonb_build_object('source_sheet', sheet_name)
  from complete_values
  where duplicate_count = 1
    and not exists (
      select 1 from municipal.observations existing_observation
      where existing_observation.import_id = selected_import_id
        and existing_observation.indicator_id = selected_indicator_id
        and existing_observation.municipality_ibge_code = complete_values.municipality_code
        and existing_observation.reference_period = complete_values.reference_period
        and existing_observation.superseded_at is null
        and coalesce(existing_observation.source_row ->> 'source_sheet', '') <> coalesce(complete_values.sheet_name, '')
    )
  on conflict (import_id, indicator_id, municipality_ibge_code, reference_period) where superseded_at is null do update
  set value = excluded.value, unit = excluded.unit, source_row = excluded.source_row;

  update core.published_values published_values
  set superseded_at = now()
  where published_values.import_id = selected_import_id
    and published_values.indicator_code = (select indicators.code from municipal.indicators indicators where indicators.id = selected_indicator_id)
    and published_values.superseded_at is null
    and not exists (
      select 1
      from municipal.observations observations
      where observations.import_id = selected_import_id
        and observations.indicator_id = selected_indicator_id
        and observations.superseded_at is null
        and observations.reference_period = published_values.reference_period
        and observations.municipality_ibge_code = published_values.dimensions ->> 'municipality_ibge_code'
    );

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
  update public.imports
  set status = case when approved_rows > 0 then 'approved'::public.import_status else 'needs_review'::public.import_status end,
    approved_at = case when approved_rows > 0 then now() else null end
  where id = selected_import_id;
  return approved_rows;
end;
$$;

grant execute on function public.approve_municipal_import(uuid, uuid, text, text, text, text, text) to service_role;
