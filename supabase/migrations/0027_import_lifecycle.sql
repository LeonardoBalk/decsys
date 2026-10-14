create index if not exists published_values_import_idx on core.published_values (import_id);

create or replace function public.unapprove_import(selected_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, core, municipal
as $$
declare
  current_status public.import_status;
  superseded_published_values integer;
  superseded_observations integer;
begin
  select imports.status into current_status
  from public.imports imports
  where imports.id = selected_import_id
  for update;

  if not found then
    raise exception 'Importacao nao encontrada.' using errcode = 'P0002';
  end if;

  if current_status <> 'approved' then
    raise exception 'Somente importacoes aprovadas podem ter a aprovacao desfeita.' using errcode = '22023';
  end if;

  update core.published_values
  set superseded_at = now()
  where import_id = selected_import_id
    and superseded_at is null;
  get diagnostics superseded_published_values = row_count;

  update municipal.observations
  set superseded_at = now()
  where import_id = selected_import_id
    and superseded_at is null;
  get diagnostics superseded_observations = row_count;

  update public.imports
  set status = 'needs_review'::public.import_status,
      approved_at = null
  where id = selected_import_id;

  return jsonb_build_object(
    'import_id', selected_import_id,
    'status', 'needs_review',
    'superseded_published_values', superseded_published_values,
    'superseded_observations', superseded_observations
  );
end;
$$;

revoke all on function public.unapprove_import(uuid) from public, anon, authenticated;
grant execute on function public.unapprove_import(uuid) to service_role;
alter function public.unapprove_import(uuid) set statement_timeout = '600s';

create or replace function public.delete_import_cascade(selected_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, core, municipal
as $$
declare
  selected_source_id uuid;
  deleted_published_values integer := 0;
  deleted_observations integer := 0;
  deleted_validation_issues integer := 0;
  deleted_treatment_proposals integer := 0;
  deleted_import_rows integer := 0;
  deleted_import_rows_batch integer;
  deleted_import_sheets integer := 0;
  deleted_imports integer := 0;
  deleted_sources integer := 0;
begin
  select imports.source_id into selected_source_id
  from public.imports imports
  where imports.id = selected_import_id
  for update;

  if not found then
    raise exception 'Importacao nao encontrada.' using errcode = 'P0002';
  end if;

  delete from core.published_values where import_id = selected_import_id;
  get diagnostics deleted_published_values = row_count;

  delete from municipal.observations where import_id = selected_import_id;
  get diagnostics deleted_observations = row_count;

  delete from public.validation_issues where import_id = selected_import_id;
  get diagnostics deleted_validation_issues = row_count;

  delete from public.treatment_proposals where import_id = selected_import_id;
  get diagnostics deleted_treatment_proposals = row_count;

  loop
    delete from public.import_rows rows_to_delete
    where rows_to_delete.id in (
      select staged_rows.id
      from public.import_rows staged_rows
      where staged_rows.import_id = selected_import_id
      limit 5000
    );
    get diagnostics deleted_import_rows_batch = row_count;
    exit when deleted_import_rows_batch = 0;
    deleted_import_rows := deleted_import_rows + deleted_import_rows_batch;
  end loop;

  delete from public.import_sheets where import_id = selected_import_id;
  get diagnostics deleted_import_sheets = row_count;

  delete from public.imports where id = selected_import_id;
  get diagnostics deleted_imports = row_count;

  if selected_source_id is not null then
    delete from public.sources
    where id = selected_source_id
      and not exists (select 1 from public.imports other_imports where other_imports.source_id = selected_source_id);
    get diagnostics deleted_sources = row_count;
  end if;

  return jsonb_build_object(
    'import_id', selected_import_id,
    'published_values', deleted_published_values,
    'observations', deleted_observations,
    'validation_issues', deleted_validation_issues,
    'treatment_proposals', deleted_treatment_proposals,
    'import_rows', deleted_import_rows,
    'import_sheets', deleted_import_sheets,
    'imports', deleted_imports,
    'sources', deleted_sources
  );
end;
$$;

revoke all on function public.delete_import_cascade(uuid) from public, anon, authenticated;
grant execute on function public.delete_import_cascade(uuid) to service_role;
alter function public.delete_import_cascade(uuid) set statement_timeout = '600s';
