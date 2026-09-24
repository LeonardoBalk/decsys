# Decsys

Decsys is an internal workspace for receiving, validating, treating and reviewing urban-indicator data. It is designed for teams that work with spreadsheets but need traceability before data is used in research or dashboards.

## Stack

- Next.js + TypeScript for the spreadsheet-like interface
- Supabase (PostgreSQL, Storage and Auth) for persistent data and files
- FastAPI + Polars for deterministic parsing and data validation
- Gemini or OpenAI for a controlled assistant that proposes mappings and treatments

The browser has read-only access to workspace data. Every write is executed by the server with explicit validation and an approved workflow; the Supabase service-role key is never exposed to the browser.

## Start locally

1. Create a Supabase project and run the migration files in `supabase/migrations` in numeric order in the SQL editor.
2. Copy `.env.example` to `.env.local` and provide the Supabase values. Do not expose the service role or AI-provider key to the browser.
3. Run `./iniciar-tratamento.ps1` in one PowerShell window.
4. Run `./iniciar-interface.ps1` in another PowerShell window.
5. Open `http://localhost:3000`.

## Checks

- `npm run lint` — ESLint (Next.js rules)
- `npm run typecheck` — generates route types and runs TypeScript
- `npm test` — frontend unit tests (Vitest)
- `.\.venv\Scripts\python.exe -m unittest services.ingestion.tests.test_import_reading services.ingestion.tests.test_municipality_matching services.ingestion.tests.test_import_flow services.ingestion.tests.test_period_preparation services.ingestion.tests.test_municipal_series` — ingestion service tests

Uploaded and downloaded sources are limited by `MAX_SOURCE_MB` (default 200 MB). After the first reading, the ingestion service keeps the file in memory for two hours (`SOURCE_CACHE_MB`, default 1 GB), so switching sheets and saving the draft do not upload or download it again.

## Entry paths

The workspace supports two entry paths: a CSV, XLSX, XLS or JSON file uploaded by the team, or a public HTTPS link. A direct data link is downloaded and profiled; a page with compatible downloads presents the discovered files for selection. The original source URL remains associated with the future import.

## From imports to dashboards

The original file and its staged rows remain attached to each import. When a reviewer approves municipal data, Decsys stores the municipal observation and a normalized copy in `core.published_values`. The dashboard reads the `core.dashboard_values` view, which returns only active, approved, non-archived values together with their indicator, period, unit, source, dataset and domain.

This lets one dashboard catalogue data from every domain while its charts filter by compatible indicator, unit and geographic level. It prevents unrelated measures from being aggregated together. Wide monthly spreadsheets can be normalized in the review screen; the original row is preserved and the normalized record receives `reference_period`.
