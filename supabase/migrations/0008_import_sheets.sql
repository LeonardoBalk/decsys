create table public.import_sheets (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete cascade,
  sheet_name text not null,
  sheet_position integer not null check (sheet_position > 0),
  row_count integer not null default 0 check (row_count >= 0),
  column_count integer not null default 0 check (column_count >= 0),
  columns_profile jsonb not null default '[]'::jsonb,
  sample_rows jsonb not null default '[]'::jsonb,
  selected_for_treatment boolean not null default false,
  created_at timestamptz not null default now(),
  unique (import_id, sheet_name)
);

create index import_sheets_import_idx on public.import_sheets (import_id, sheet_position);

alter table public.import_sheets enable row level security;
create policy "authenticated users may read import sheets" on public.import_sheets for select to authenticated using (true);
grant all privileges on public.import_sheets to service_role;
