"""Decsys Ingestion API: monta o app e registra os roteadores. A logica fica nos modulos ao lado."""
from fastapi import FastAPI

import httpx  # noqa: F401  (os testes substituem httpx.get/post/patch/delete por aqui)

from . import config  # noqa: F401
from . import ai_assessment
from . import approval
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
from . import routes_imports
from . import routes_indicators
from . import source_cache
from . import source_limits
from . import supabase_client
from . import table_reading
from .models import *  # noqa: F401,F403
from .row_filters import *  # noqa: F401,F403
from .supabase_client import *  # noqa: F401,F403
from .source_limits import *  # noqa: F401,F403
from .source_cache import *  # noqa: F401,F403
from .remote_sources import *  # noqa: F401,F403
from .table_reading import *  # noqa: F401,F403
from .ai_assessment import *  # noqa: F401,F403
from .import_store import *  # noqa: F401,F403
from .municipalities import *  # noqa: F401,F403
from .periods import *  # noqa: F401,F403
from .approval import *  # noqa: F401,F403
from .routes_health import *  # noqa: F401,F403
from .routes_indicators import *  # noqa: F401,F403
from .routes_iiu import *  # noqa: F401,F403
from .routes_collection_sources import *  # noqa: F401,F403
from .routes_imports import *  # noqa: F401,F403
from .config import *  # noqa: F401,F403

app = FastAPI(title="Decsys Ingestion API", version="0.2.0")
for _router_module in (routes_collection_sources, routes_health, routes_iiu, routes_imports, routes_indicators, approval, municipalities, jobs, routes_filters):
    app.include_router(_router_module.router)
