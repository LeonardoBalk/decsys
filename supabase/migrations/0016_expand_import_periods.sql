-- Transforma uma medida distribuída em várias colunas de período (por exemplo,
-- janeiro_2020_saldos ... julho_2026_saldos) em uma aba derivada com uma linha por
-- município e período. A aba original continua intacta.

create or replace function public.expand_import_periods(
  selected_import_id uuid,
  source_sheet_name text,
  target_sheet_name text,
  selected_municipality_field text,
  identity_fields text[],
  period_columns jsonb
)
returns table (created_rows integer, empty_cells integer, unresolved_rows integer)
language plpgsql
security definer
set search_path = public, municipal
as $$
declare
  candidate_count integer;
begin
  if source_sheet_name = target_sheet_name then
    raise exception 'A aba derivada precisa ter um nome diferente da aba de origem.';
  end if;

  delete from public.import_rows
  where import_id = selected_import_id and sheet_name = target_sheet_name;

  select count(*) * jsonb_array_length(period_columns) into candidate_count
  from public.import_rows
  where import_id = selected_import_id and sheet_name = source_sheet_name;

  with source_rows as (
    select import_rows.row_number,
      import_rows.raw_row,
      import_rows.raw_row || coalesce(import_rows.normalized_row, '{}'::jsonb) as source_row
    from public.import_rows
    where import_rows.import_id = selected_import_id
      and import_rows.sheet_name = source_sheet_name
  ), expanded as (
    select source_rows.row_number as source_row_number,
      period.ordinality as period_position,
      source_rows.raw_row,
      period.item ->> 'field' as period_field,
      (period.item ->> 'year')::integer as reference_year,
      nullif(period.item ->> 'month', '')::integer as reference_month,
      btrim(coalesce(source_rows.source_row ->> selected_municipality_field, '')) as municipality_text,
      btrim(coalesce(source_rows.source_row ->> (period.item ->> 'field'), '')) as value_text
    from source_rows
    cross join lateral jsonb_array_elements(period_columns) with ordinality as period(item, ordinality)
  ), code_prefixes as (
    select left(ibge_code, 6) as code_prefix, min(ibge_code) as ibge_code
    from municipal.municipalities
    group by left(ibge_code, 6)
  ), municipality_codes as (
    select distinct_texts.municipality_text,
      coalesce(exact_match.ibge_code, prefix_match.ibge_code) as municipality_code
    from (select distinct municipality_text from expanded) distinct_texts
    left join municipal.municipalities exact_match
      on distinct_texts.municipality_text ~ '^[0-9]{7}$' and exact_match.ibge_code = distinct_texts.municipality_text
    left join code_prefixes prefix_match
      on distinct_texts.municipality_text ~ '^[0-9]{6}$' and prefix_match.code_prefix = distinct_texts.municipality_text
  ), resolved as (
    select expanded.*,
      municipality_codes.municipality_code,
      case
        when expanded.value_text ~ '^-?[0-9]{1,3}(\.[0-9]{3})+(,[0-9]+)?%?$' or expanded.value_text ~ '^-?[0-9]+,[0-9]+%?$'
          then replace(replace(rtrim(expanded.value_text, '%'), '.', ''), ',', '.')
        when expanded.value_text ~ '^-?[0-9]+(\.[0-9]+)?%?$'
          then rtrim(expanded.value_text, '%')
      end as numeric_text
    from expanded
    left join municipality_codes on municipality_codes.municipality_text = expanded.municipality_text
    where expanded.value_text <> ''
  )
  insert into public.import_rows (import_id, sheet_name, row_number, raw_row, normalized_row)
  select selected_import_id,
    target_sheet_name,
    (row_number() over (order by resolved.source_row_number, resolved.period_position))::integer,
    coalesce((
      select jsonb_object_agg(identity_field, resolved.raw_row -> identity_field)
      from unnest(identity_fields) as identity_field
      where resolved.raw_row ? identity_field
    ), '{}'::jsonb) || jsonb_build_object(
      'linha_original', resolved.source_row_number,
      'coluna_original', resolved.period_field,
      'competencia', case when resolved.reference_month is null then resolved.reference_year::text else make_date(resolved.reference_year, resolved.reference_month, 1)::text end,
      'valor', resolved.raw_row -> resolved.period_field
    ),
    jsonb_strip_nulls(jsonb_build_object(
      'municipality_ibge_code', resolved.municipality_code,
      'reference_year', resolved.reference_year::text,
      'reference_period', case when resolved.reference_month is not null then make_date(resolved.reference_year, resolved.reference_month, 1)::text end,
      'value', resolved.numeric_text,
      'source_measure', resolved.period_field
    ))
  from resolved;

  get diagnostics created_rows = row_count;
  empty_cells := candidate_count - created_rows;
  select count(*) into unresolved_rows
  from public.import_rows
  where import_id = selected_import_id
    and sheet_name = target_sheet_name
    and not (normalized_row ? 'municipality_ibge_code');
  return next;
end;
$$;

revoke all on function public.expand_import_periods(uuid, text, text, text, text[], jsonb) from public;
grant execute on function public.expand_import_periods(uuid, text, text, text, text[], jsonb) to service_role;
