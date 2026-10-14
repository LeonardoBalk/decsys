create or replace view public.indicator_coverage as
select dashboard_values.indicator_code,
  count(distinct dashboard_values.dimensions ->> 'municipality_ibge_code') as municipalities,
  count(*) as value_count,
  min(dashboard_values.reference_period) as first_reference_period,
  max(dashboard_values.reference_period) as last_reference_period
from core.dashboard_values dashboard_values
group by dashboard_values.indicator_code;

grant select on public.indicator_coverage to service_role;
