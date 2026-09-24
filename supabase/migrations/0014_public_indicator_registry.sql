-- O PostgREST do projeto só expõe o schema public. Cadastro de indicadores e de
-- municípios precisa passar por objetos públicos, como já acontece nas leituras.

create or replace view public.indicator_registry as
select id, code, name, dimension, definition, unit, expected_frequency, active, created_at
from municipal.indicators;

grant select, insert, update on public.indicator_registry to service_role;

create or replace function public.register_municipalities(selected_municipalities jsonb)
returns integer
language plpgsql
security definer
set search_path = municipal, public
as $$
declare
  registered_count integer;
begin
  insert into municipal.municipalities (ibge_code, name, state)
  select municipality ->> 'ibge_code', municipality ->> 'name', municipality ->> 'state'
  from jsonb_array_elements(selected_municipalities) as municipality
  on conflict (ibge_code) do update set name = excluded.name, state = excluded.state;
  get diagnostics registered_count = row_count;
  return registered_count;
end;
$$;

revoke all on function public.register_municipalities(jsonb) from public;
grant execute on function public.register_municipalities(jsonb) to service_role;
