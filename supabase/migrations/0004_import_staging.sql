alter table public.imports
  add column profile jsonb not null default '{}'::jsonb,
  add column processed_storage_path text,
  add column total_rows integer not null default 0 check (total_rows >= 0);

create table public.import_rows (
  id bigint generated always as identity primary key,
  import_id uuid not null references public.imports(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  raw_row jsonb not null,
  normalized_row jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (import_id, row_number)
);

create index import_rows_import_idx on public.import_rows (import_id, row_number);

alter table public.import_rows enable row level security;

create policy "authenticated users may read staged import rows" on public.import_rows
  for select to authenticated using (true);

grant all privileges on public.import_rows to service_role;
grant usage, select on sequence public.import_rows_id_seq to service_role;
