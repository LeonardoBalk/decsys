-- Arquiva os indicadores do modelo antigo do IIU (os 42 anteriores a matriz da tese).
-- Eles saem das listas de importacao e de indicadores; valores ja publicados com esses codigos continuam existindo.
-- Para reativar um deles, use a tela Indicadores ou: update municipal.indicators set active = true where code = '...';
-- A configuracao antiga continua guardada em core.iiu_legacy_snapshot (migration 0023).

update municipal.indicators
set active = false
where active
  and code !~ '^(eco|pes|gov|mob|amb|qvi|idd)[0-9]{2}_'
  and not exists (
    select 1 from core.published_values published_values where published_values.indicator_code = municipal.indicators.code and published_values.superseded_at is null
  );
