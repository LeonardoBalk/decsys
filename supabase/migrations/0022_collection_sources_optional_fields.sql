alter table public.collection_sources drop constraint if exists collection_sources_dimension_check;
alter table public.collection_sources drop constraint if exists collection_sources_name_check;
alter table public.collection_sources drop constraint if exists collection_sources_source_check;
alter table public.collection_sources drop constraint if exists collection_sources_steps_check;
alter table public.collection_sources drop constraint if exists collection_sources_check;
alter table public.collection_sources alter column dimension set default 'Outras';
alter table public.collection_sources alter column source set default '';
alter table public.collection_sources alter column steps set default '';
