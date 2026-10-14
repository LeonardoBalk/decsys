update municipal.indicators
set active = false
where active
  and code !~ '^(eco|pes|gov|mob|amb|qvi|idd)[0-9]{2}_'
  and not exists (
    select 1 from core.published_values published_values where published_values.indicator_code = municipal.indicators.code and published_values.superseded_at is null
  );
