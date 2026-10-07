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
