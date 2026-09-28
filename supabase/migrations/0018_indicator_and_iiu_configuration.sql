alter table municipal.indicators
  add column if not exists calculation_type text not null default 'direct' check (calculation_type in ('direct', 'ratio')),
  add column if not exists calculation_multiplier numeric not null default 1 check (calculation_multiplier > 0 and calculation_multiplier <= 1000000);

create or replace view public.indicator_registry as
select id, code, name, dimension, definition, unit, expected_frequency, active, created_at,
  calculation_type, calculation_multiplier, iiu_enabled, iiu_dimension_code, iiu_type,
  source_description, score_direction, checklist_max
from municipal.indicators;

grant select, insert, update on public.indicator_registry to service_role;


create table if not exists core.iiu_configuration_history (
  id bigint generated always as identity primary key,
  entity_type text not null,
  entity_key text not null,
  old_values jsonb,
  new_values jsonb,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create or replace function core.audit_iiu_configuration()
returns trigger
language plpgsql
security definer
set search_path = core, public
as $$
declare
  selected_entity_key text;
  previous_values jsonb;
  updated_values jsonb;
begin
  if tg_op = 'DELETE' then
    previous_values := to_jsonb(old);
  else
    updated_values := to_jsonb(new);
    if tg_op = 'UPDATE' then
      previous_values := to_jsonb(old);
    end if;
  end if;
  if tg_op = 'DELETE' then
    if tg_table_name = 'iiu_dimension_weights' then
      selected_entity_key := old.city_profile::text || ':' || old.dimension_code;
    elsif tg_table_name = 'iiu_indicator_benchmarks' then
      selected_entity_key := old.indicator_id::text || ':' || old.city_profile::text;
    else
      selected_entity_key := old.code;
    end if;
  elsif tg_table_name = 'iiu_dimension_weights' then
    selected_entity_key := new.city_profile::text || ':' || new.dimension_code;
  elsif tg_table_name = 'iiu_indicator_benchmarks' then
    selected_entity_key := new.indicator_id::text || ':' || new.city_profile::text;
  else
    selected_entity_key := coalesce(new.code, old.code);
  end if;
  insert into core.iiu_configuration_history (entity_type, entity_key, old_values, new_values, changed_by)
  values (
    tg_table_name,
    selected_entity_key,
    previous_values,
    updated_values,
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists iiu_dimension_weights_audit on core.iiu_dimension_weights;
create trigger iiu_dimension_weights_audit after insert or update or delete on core.iiu_dimension_weights for each row execute function core.audit_iiu_configuration();

drop trigger if exists iiu_indicator_benchmarks_audit on core.iiu_indicator_benchmarks;
create trigger iiu_indicator_benchmarks_audit after insert or update or delete on core.iiu_indicator_benchmarks for each row execute function core.audit_iiu_configuration();

drop trigger if exists municipal_indicator_iiu_audit on municipal.indicators;
create trigger municipal_indicator_iiu_audit after insert or update of calculation_type, calculation_multiplier, score_direction, checklist_max, iiu_enabled, iiu_dimension_code on municipal.indicators for each row execute function core.audit_iiu_configuration();

create or replace view public.iiu_configuration_history as
select id, entity_type, entity_key, old_values, new_values, changed_by, changed_at
from core.iiu_configuration_history;

grant select on public.iiu_configuration_history to service_role;

create or replace function public.save_iiu_dimension_weights(selected_city_profile text, selected_weights jsonb)
returns integer
language plpgsql
security definer
set search_path = core, public
as $$
declare
  selected_profile core.iiu_city_profile;
  dimension_count integer;
  updated_count integer;
begin
  if selected_city_profile not in ('pequeno', 'medio', 'grande', 'metropole') then
    raise exception 'Porte municipal inválido.' using errcode = '22023';
  end if;
  if jsonb_typeof(selected_weights) <> 'object' then
    raise exception 'Informe os pesos das dimensões.' using errcode = '22023';
  end if;
  select count(*) into dimension_count from core.iiu_dimensions;
  if jsonb_object_length(selected_weights) <> dimension_count then
    raise exception 'Informe exatamente um peso para cada dimensão.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_each_text(selected_weights) weights
    left join core.iiu_dimensions dimensions on dimensions.code = weights.key
    where dimensions.code is null or weights.value !~ '^[0-9]+([.][0-9]{1,2})?$'
      or case when weights.value ~ '^[0-9]+([.][0-9]{1,2})?$' then weights.value::numeric <= 0 or weights.value::numeric > 100 else false end
  ) then
    raise exception 'Cada peso precisa ser um número maior que zero e até 100.' using errcode = '22023';
  end if;
  if abs((select sum(weights.value::numeric) from jsonb_each_text(selected_weights) weights) - 100) > 0.01 then
    raise exception 'A soma dos pesos precisa ser 100%%.' using errcode = '22023';
  end if;
  selected_profile := selected_city_profile::core.iiu_city_profile;
  insert into core.iiu_dimension_weights (city_profile, dimension_code, weight)
  select selected_profile, weights.key, weights.value::numeric
  from jsonb_each_text(selected_weights) weights
  on conflict (city_profile, dimension_code) do update set weight = excluded.weight;
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

create or replace function public.save_iiu_indicator_benchmark(selected_indicator_code text, selected_city_profile text, selected_minimum numeric, selected_maximum numeric)
returns jsonb
language plpgsql
security definer
set search_path = core, municipal, public
as $$
declare
  selected_indicator_id uuid;
  selected_profile core.iiu_city_profile;
begin
  if selected_city_profile not in ('pequeno', 'medio', 'grande', 'metropole') then
    raise exception 'Porte municipal inválido.' using errcode = '22023';
  end if;
  if selected_minimum is null or selected_maximum is null or selected_minimum >= selected_maximum then
    raise exception 'O limite máximo precisa ser maior que o mínimo.' using errcode = '22023';
  end if;
  select id into selected_indicator_id from municipal.indicators where code = selected_indicator_code and iiu_enabled and active;
  if selected_indicator_id is null then
    raise exception 'Indicador do IIU não encontrado.' using errcode = 'P0002';
  end if;
  selected_profile := selected_city_profile::core.iiu_city_profile;
  insert into core.iiu_indicator_benchmarks (indicator_id, city_profile, minimum_value, maximum_value)
  values (selected_indicator_id, selected_profile, selected_minimum, selected_maximum)
  on conflict (indicator_id, city_profile) do update set minimum_value = excluded.minimum_value, maximum_value = excluded.maximum_value, updated_at = now();
  return jsonb_build_object('indicator_code', selected_indicator_code, 'city_profile', selected_city_profile, 'minimum_value', selected_minimum, 'maximum_value', selected_maximum);
end;
$$;

create or replace function public.iiu_try_numeric(selected_value text)
returns numeric
language plpgsql
immutable
set search_path = public
as $$
declare
  normalized_input text;
begin
  if selected_value is null or length(btrim(selected_value)) > 64 then
    return null;
  end if;
  normalized_input := regexp_replace(btrim(selected_value), '[[:space:]%]', '', 'g');
  if normalized_input ~ '^-?[0-9]{1,3}(,[0-9]{3})+([.][0-9]+)?$' then
    normalized_input := replace(normalized_input, ',', '');
  elsif normalized_input ~ '^-?[0-9]{1,3}([.][0-9]{3})+(,[0-9]+)?$' then
    normalized_input := replace(normalized_input, '.', '');
  elsif normalized_input ~ '^-?[0-9]+,[0-9]+$' then
    null;
  elsif normalized_input ~ '^-?[0-9]*[.][0-9]+$' then
    null;
  elsif normalized_input ~ '^-?[0-9]+$' then
    null;
  else
    return null;
  end if;
  normalized_input := replace(normalized_input, ',', '.');
  if normalized_input !~ '^-?([0-9]+([.][0-9]*)?|[.][0-9]+)$' then
    return null;
  end if;
  return normalized_input::numeric;
exception when numeric_value_out_of_range or invalid_text_representation then
  return null;
end;
$$;

create or replace function public.iiu_try_numeric(selected_value jsonb)
returns numeric
language plpgsql
immutable
set search_path = public
as $$
begin
  if selected_value is null or jsonb_typeof(selected_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(selected_value) = 'number' then
    return (selected_value #>> '{}')::numeric;
  end if;
  if jsonb_typeof(selected_value) = 'string' then
    return public.iiu_try_numeric(selected_value #>> '{}');
  end if;
  return null;
exception when numeric_value_out_of_range or invalid_text_representation then
  return null;
end;
$$;

create or replace function public.preview_municipal_import_calculation(selected_import_id uuid, selected_sheet_name text, calculation_type text, direct_field text, numerator_field text, denominator_field text, calculation_multiplier numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  preview_result jsonb;
begin
  if calculation_type not in ('direct', 'ratio') then
    raise exception 'Tipo de cálculo inválido.' using errcode = '22023';
  end if;
  if calculation_type = 'direct' and coalesce(direct_field, '') = '' then
    raise exception 'Escolha a coluna que contém o valor do indicador.' using errcode = '22023';
  end if;
  if calculation_type = 'ratio' and (coalesce(numerator_field, '') = '' or coalesce(denominator_field, '') = '' or numerator_field = denominator_field or calculation_multiplier is null or calculation_multiplier <= 0) then
    raise exception 'Escolha as colunas do numerador e denominador e um multiplicador válido.' using errcode = '22023';
  end if;
  with source_rows as (
    select row_number, raw_row || coalesce(normalized_row, '{}'::jsonb) as source_row
    from public.import_rows
    where import_id = selected_import_id and (selected_sheet_name is null or sheet_name = selected_sheet_name)
  ), calculated_rows as (
    select row_number, source_row,
      case when calculation_type = 'direct' then public.iiu_try_numeric(source_row -> direct_field)
        when public.iiu_try_numeric(source_row -> denominator_field) is not null and public.iiu_try_numeric(source_row -> denominator_field) <> 0
        then public.iiu_try_numeric(source_row -> numerator_field) / public.iiu_try_numeric(source_row -> denominator_field) * calculation_multiplier
      end as calculated_value
    from source_rows
  )
  select jsonb_build_object(
    'total_rows', count(*),
    'valid_rows', count(*) filter (where calculated_value is not null),
    'invalid_rows', count(*) filter (where calculated_value is null),
    'examples', coalesce((
      select jsonb_agg(jsonb_build_object(
        'row_number', example.row_number,
        'municipality', coalesce(example.source_row ->> 'municipality_ibge_code', example.source_row ->> 'municipio', example.source_row ->> 'municipality'),
        'numerator', case when calculation_type = 'ratio' then example.source_row ->> numerator_field else example.source_row ->> direct_field end,
        'denominator', case when calculation_type = 'ratio' then example.source_row ->> denominator_field end,
        'calculated_value', example.calculated_value,
        'valid', example.calculated_value is not null
      ) order by example.row_number)
      from (select * from calculated_rows order by row_number limit 10) example
    ), '[]'::jsonb)
  ) into preview_result
  from calculated_rows;
  return coalesce(preview_result, jsonb_build_object('total_rows', 0, 'valid_rows', 0, 'invalid_rows', 0, 'examples', '[]'::jsonb));
end;
$$;

create or replace function public.prepare_municipal_import_calculation(selected_import_id uuid, selected_sheet_name text, numerator_field text, denominator_field text, calculation_multiplier numeric)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  prepared_rows integer;
begin
  if coalesce(numerator_field, '') = '' or coalesce(denominator_field, '') = '' or numerator_field = denominator_field or calculation_multiplier is null or calculation_multiplier <= 0 then
    raise exception 'Informe os campos e o multiplicador da fórmula.' using errcode = '22023';
  end if;
  update public.import_rows imported_rows
  set normalized_row = coalesce(imported_rows.normalized_row, '{}'::jsonb) || jsonb_build_object(
    'value', calculated_values.calculated_value,
    'calculation_type', 'ratio',
    'calculation_numerator_field', numerator_field,
    'calculation_denominator_field', denominator_field,
    'calculation_multiplier', calculation_multiplier
  )
  from (
    select row_number, sheet_name,
      case when public.iiu_try_numeric((raw_row || coalesce(normalized_row, '{}'::jsonb)) -> denominator_field) is not null
        and public.iiu_try_numeric((raw_row || coalesce(normalized_row, '{}'::jsonb)) -> denominator_field) <> 0
        then public.iiu_try_numeric((raw_row || coalesce(normalized_row, '{}'::jsonb)) -> numerator_field) / public.iiu_try_numeric((raw_row || coalesce(normalized_row, '{}'::jsonb)) -> denominator_field) * calculation_multiplier
      end as calculated_value
    from public.import_rows
    where import_id = selected_import_id and (selected_sheet_name is null or sheet_name = selected_sheet_name)
  ) calculated_values
  where imported_rows.import_id = selected_import_id and imported_rows.row_number = calculated_values.row_number
    and imported_rows.sheet_name is not distinct from calculated_values.sheet_name
    and (selected_sheet_name is null or imported_rows.sheet_name = selected_sheet_name);
  get diagnostics prepared_rows = row_count;
  return prepared_rows;
end;
$$;

grant execute on function public.save_iiu_dimension_weights(text, jsonb) to service_role;
grant execute on function public.save_iiu_indicator_benchmark(text, text, numeric, numeric) to service_role;
grant execute on function public.preview_municipal_import_calculation(uuid, text, text, text, text, text, numeric) to service_role;
grant execute on function public.prepare_municipal_import_calculation(uuid, text, text, text, numeric) to service_role;

revoke all on function public.save_iiu_dimension_weights(text, jsonb) from public, anon, authenticated;
revoke all on function public.save_iiu_indicator_benchmark(text, text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.preview_municipal_import_calculation(uuid, text, text, text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.prepare_municipal_import_calculation(uuid, text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.iiu_try_numeric(text) from public, anon, authenticated;
revoke all on function public.iiu_try_numeric(jsonb) from public, anon, authenticated;
