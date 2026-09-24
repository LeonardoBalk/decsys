-- Informa se cada valor publicado se refere a um mês ou a um ano inteiro.
-- A aprovação só usa um período mensal quando a linha traz reference_period
-- (gravado pela transformação de colunas mensais); nos demais casos o período vem do ano.

create or replace view core.dashboard_values as
select published_values.id,
  published_values.import_id,
  published_values.dataset_id,
  datasets.dataset_name,
  domains.domain_name,
  published_values.indicator_code,
  published_values.indicator_name,
  published_values.dimensions,
  published_values.reference_period,
  published_values.value,
  published_values.unit,
  imports.title as import_title,
  sources.name as source_name,
  case when published_values.source_row ->> 'reference_period' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-01$'
    then 'month' else 'year'
  end as period_granularity
from core.published_values published_values
left join core.datasets datasets on datasets.dataset_id = published_values.dataset_id
left join core.domains domains on domains.domain_id = datasets.domain_id
join public.imports imports on imports.id = published_values.import_id
join public.sources sources on sources.id = imports.source_id
where published_values.superseded_at is null
  and imports.status = 'approved'
  and imports.archived_at is null;

grant select on core.dashboard_values to authenticated, service_role;

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
  source_name,
  period_granularity
from core.dashboard_values;

grant select on public.dashboard_values to service_role;
