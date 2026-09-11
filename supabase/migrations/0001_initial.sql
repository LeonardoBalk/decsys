create extension if not exists pgcrypto;

create type public.import_status as enum ('draft', 'analyzing', 'needs_review', 'approved', 'archived', 'discarded');
create type public.validation_severity as enum ('info', 'warning', 'error');

create table public.municipalities (
  ibge_code text primary key check (ibge_code ~ '^[0-9]{7}$'),
  name text not null,
  state char(2) not null check (state ~ '^[A-Z]{2}$'),
  created_at timestamptz not null default now()
);

create table public.indicators (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  dimension text not null,
  definition text not null,
  unit text not null,
  expected_frequency text,
  formula text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  publisher text,
  base_url text,
  trust_level smallint not null default 2 check (trust_level between 1 and 3),
  notes text,
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.sources(id) on delete restrict,
  title text not null,
  reference_year integer,
  source_url text,
  storage_path text,
  file_name text,
  file_sha256 text,
  status public.import_status not null default 'draft',
  imported_by uuid references auth.users(id) on delete set null,
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.treatment_proposals (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete cascade,
  target_indicator_id uuid references public.indicators(id) on delete restrict,
  mapping jsonb not null default '{}'::jsonb,
  calculation jsonb not null default '{}'::jsonb,
  explanation text not null,
  confidence numeric(4,3) check (confidence between 0 and 1),
  created_at timestamptz not null default now()
);

create table public.validation_issues (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete cascade,
  severity public.validation_severity not null,
  row_number integer,
  field text,
  message text not null,
  created_at timestamptz not null default now()
);

create table public.observations (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.imports(id) on delete restrict,
  indicator_id uuid not null references public.indicators(id) on delete restrict,
  municipality_ibge_code text not null references public.municipalities(ibge_code) on delete restrict,
  reference_year integer not null check (reference_year between 1900 and 2200),
  value numeric,
  unit text not null,
  numerator numeric,
  denominator numeric,
  source_row jsonb not null default '{}'::jsonb,
  notes text,
  superseded_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index observations_active_unique
  on public.observations (import_id, indicator_id, municipality_ibge_code, reference_year)
  where superseded_at is null;
create index observations_indicator_year_idx on public.observations (indicator_id, reference_year);
create index observations_municipality_idx on public.observations (municipality_ibge_code);
create index observations_import_idx on public.observations (import_id);
create index imports_source_idx on public.imports (source_id);
create index imports_status_idx on public.imports (status);
create index treatment_proposals_import_idx on public.treatment_proposals (import_id);
create index validation_issues_import_idx on public.validation_issues (import_id);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger imports_set_updated_at
before update on public.imports
for each row execute function public.set_updated_at();

alter table public.municipalities enable row level security;
alter table public.indicators enable row level security;
alter table public.sources enable row level security;
alter table public.imports enable row level security;
alter table public.treatment_proposals enable row level security;
alter table public.validation_issues enable row level security;
alter table public.observations enable row level security;

create policy "authenticated users may read workspace data" on public.municipalities for select to authenticated using (true);
create policy "authenticated users may read indicators" on public.indicators for select to authenticated using (true);
create policy "authenticated users may read sources" on public.sources for select to authenticated using (true);
create policy "authenticated users may read imports" on public.imports for select to authenticated using (true);
create policy "authenticated users may read proposals" on public.treatment_proposals for select to authenticated using (true);
create policy "authenticated users may read validation issues" on public.validation_issues for select to authenticated using (true);
create policy "authenticated users may read observations" on public.observations for select to authenticated using (true);

insert into storage.buckets (id, name, public) values ('source-files', 'source-files', false)
on conflict (id) do nothing;
