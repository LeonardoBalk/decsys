-- Mesma regra de aprovação da 0013, reescrita para escalar.
-- Na versão anterior, a checagem "outra aba já informa este município e período" e a
-- deduplicação de pendências consultavam as próprias tabelas que o comando estava
-- preenchendo; cada linha relia tudo o que já tinha sido inserido (custo quadrático:
-- ~28 s para 20 mil linhas, horas para 440 mil). Agora candidatos, conflitos e
-- pendências existentes são calculados antes, em tabelas temporárias.

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

  drop table if exists pg_temp.approval_candidates;
  create temp table approval_candidates on commit drop as
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
      btrim(coalesce(staged_values.source_row ->> value_field, '')) as value_text
    from staged_values
  ), validated_values as (
    select checked_values.*,
      (checked_values.municipality_code ~ '^[0-9]{7}$' and municipalities.ibge_code is not null) as valid_municipality,
      case when checked_values.year_text ~ '^[0-9]{4}([.]0+)?$'
        then regexp_replace(checked_values.year_text, '[.]0+$', '')::integer between 1900 and 2200
        else false
      end as valid_year,
      (length(checked_values.value_text) <= 64 and checked_values.value_text ~ '^-?[0-9]+([.][0-9]+)?$') as valid_value
    from checked_values
    left join municipal.municipalities municipalities on municipalities.ibge_code = checked_values.municipality_code
  )
  select validated_values.*,
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
  from validated_values;

  create index on approval_candidates (municipality_code, reference_period);
  analyze approval_candidates;

  drop table if exists pg_temp.approval_conflicts;
  create temp table approval_conflicts on commit drop as
  select distinct candidates.row_number, candidates.sheet_name
  from approval_candidates candidates
  join municipal.observations existing_observation
    on existing_observation.import_id = selected_import_id
    and existing_observation.indicator_id = selected_indicator_id
    and existing_observation.superseded_at is null
    and existing_observation.municipality_ibge_code = candidates.municipality_code
    and existing_observation.reference_period = candidates.reference_period
    and coalesce(existing_observation.source_row ->> 'source_sheet', '') <> coalesce(candidates.sheet_name, '')
  where candidates.valid_municipality and candidates.valid_year and candidates.valid_value;

  drop table if exists pg_temp.approval_existing_issues;
  create temp table approval_existing_issues on commit drop as
  select distinct row_number, field, message
  from public.validation_issues
  where import_id = selected_import_id;

  insert into public.validation_issues (import_id, severity, row_number, field, message)
  select selected_import_id, 'error', new_issues.row_number, new_issues.field, new_issues.message
  from (
    select distinct candidates.row_number, invalid_values.field,
      format('Aba "%s": %s', candidates.sheet_name, invalid_values.message) as message
    from approval_candidates candidates
    left join approval_conflicts conflicts on conflicts.row_number = candidates.row_number and conflicts.sheet_name is not distinct from candidates.sheet_name
    cross join lateral (values
      (municipality_field, not candidates.valid_municipality, 'Código IBGE inválido ou município inexistente.'),
      (year_field, not candidates.valid_year, 'Ano inválido. Informe um ano entre 1900 e 2200.'),
      (value_field, not candidates.valid_value, 'Valor inválido. Informe um número com ponto decimal ou converta o formato brasileiro antes da gravação.'),
      (municipality_field, candidates.duplicate_count > 1, 'Mais de uma linha deste arquivo informa valor para o mesmo município e período; nenhuma delas foi gravada.'),
      (municipality_field, conflicts.row_number is not null, 'Outra aba deste arquivo já informa um valor para o mesmo município e período; escolha uma única linha de origem.')
    ) as invalid_values(field, has_error, message)
    where invalid_values.has_error
  ) new_issues
  left join approval_existing_issues existing_issue
    on existing_issue.row_number = new_issues.row_number
    and existing_issue.field = new_issues.field
    and existing_issue.message = new_issues.message
  where existing_issue.row_number is null;

  insert into municipal.observations (import_id, indicator_id, municipality_ibge_code, reference_year, reference_period, value, unit, source_row)
  select selected_import_id,
    selected_indicator_id,
    candidates.municipality_code,
    candidates.reference_year,
    candidates.reference_period,
    candidates.value_text::numeric,
    observation_unit,
    candidates.source_row || jsonb_build_object('source_sheet', candidates.sheet_name)
  from approval_candidates candidates
  left join approval_conflicts conflicts on conflicts.row_number = candidates.row_number and conflicts.sheet_name is not distinct from candidates.sheet_name
  where candidates.valid_municipality and candidates.valid_year and candidates.valid_value
    and candidates.duplicate_count = 1
    and conflicts.row_number is null
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
