-- Torna opcionais os campos de collection_sources (so a sigla, que e a chave, continua obrigatoria).
-- Necessaria apenas para quem ja aplicou a versao inicial da 0021; instalacoes novas ja nascem assim.

alter table public.collection_sources drop constraint if exists collection_sources_dimension_check;
alter table public.collection_sources drop constraint if exists collection_sources_name_check;
alter table public.collection_sources drop constraint if exists collection_sources_source_check;
alter table public.collection_sources drop constraint if exists collection_sources_steps_check;
alter table public.collection_sources drop constraint if exists collection_sources_check;
alter table public.collection_sources alter column dimension set default 'Outras';
alter table public.collection_sources alter column source set default '';
alter table public.collection_sources alter column steps set default '';
