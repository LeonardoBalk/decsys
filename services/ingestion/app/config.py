import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parents[1] / ".env")


ai_assessment_size_limit = 20 * 1024 * 1024

ai_assessment_timeout = 10.0

supported_extensions = {".csv", ".xlsx", ".xls", ".json"}

archive_extensions = {".zip", ".gz"}

acceptable_extensions = supported_extensions | archive_extensions

maximum_redirect_hops = 5

maximum_source_bytes = int(os.getenv("MAX_SOURCE_MB", "200")) * 1024 * 1024

source_cache_ttl_seconds = 2 * 60 * 60

source_cache_max_bytes = int(os.getenv("SOURCE_CACHE_MB", "1024")) * 1024 * 1024

ibge_catalog_ttl_seconds = 24 * 60 * 60
