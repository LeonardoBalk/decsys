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
