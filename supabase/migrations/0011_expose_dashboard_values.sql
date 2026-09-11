create or replace view public.dashboard_values as
select id,
  import_id,
  dataset_id,
  dataset_name,
  domain_name,
  indicator_code,
  indicator_name,
  dimensions,
  reference_period,
  value,
  unit,
  import_title,
  source_name
from core.dashboard_values;

grant select on public.dashboard_values to service_role;
