from fastapi import FastAPI

import httpx

from . import config
from . import ai_assessment
from . import approval
from . import benchmarks
from . import import_store
from . import jobs
from . import models
from . import municipalities
from . import periods
from . import population
from . import remote_sources
from . import routes_collection_sources
from . import routes_filters
from . import routes_health
from . import routes_iiu
from . import routes_iiu_panels
from . import routes_import_lifecycle
from . import routes_imports
from . import routes_indicators
from . import source_cache
from . import source_limits
from . import supabase_client
from . import table_reading
from .models import *
from .row_filters import *
from .supabase_client import *
from .source_limits import *
from .source_cache import *
from .remote_sources import *
from .table_reading import *
from .ai_assessment import *
from .import_store import *
from .municipalities import *
from .periods import *
from .approval import *
from .routes_health import *
from .routes_indicators import *
from .routes_iiu import *
from .routes_collection_sources import *
from .routes_import_lifecycle import *
from .routes_imports import *
from .config import *

app = FastAPI(title="Decsys Ingestion API", version="0.2.0")
for _router_module in (routes_collection_sources, routes_health, routes_iiu, routes_iiu_panels, routes_import_lifecycle, routes_imports, routes_indicators, approval, municipalities, jobs, routes_filters, benchmarks):
    app.include_router(_router_module.router)
