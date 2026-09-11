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
