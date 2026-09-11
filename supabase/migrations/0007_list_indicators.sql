create or replace function public.list_active_indicators()
returns table (id uuid, code text, name text, unit text)
language sql
stable
security definer
set search_path = public, municipal
as $$
  select id, code, name, unit from municipal.indicators where active order by name;
$$;

grant execute on function public.list_active_indicators() to service_role;
