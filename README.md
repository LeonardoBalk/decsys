# Decsys

Decsys is an internal workspace for receiving, validating, treating and reviewing urban-indicator data. It is designed for teams that work with spreadsheets but need traceability before data is used in research or dashboards.

## Stack

- Next.js + TypeScript for the spreadsheet-like interface
- Supabase (PostgreSQL, Storage and Auth) for persistent data and files
- FastAPI + Polars for deterministic parsing and data validation
- OpenAI Responses API for a controlled assistant that proposes mappings and treatments

The browser has read-only access to workspace data. Every write is executed by the server with explicit validation and an approved workflow; the Supabase service-role key is never exposed to the browser.

## Start locally

1. Create a Supabase project and run `supabase/migrations/0001_initial.sql` in the SQL editor.
2. Copy `.env.example` to `.env.local` and provide the Supabase values. Do not expose the service role or OpenAI key to the browser.
3. Run `./iniciar-tratamento.ps1` in one PowerShell window.
4. Run `./iniciar-interface.ps1` in another PowerShell window.
5. Open `http://localhost:3000`.

The workspace supports two entry paths: a CSV, XLSX, XLS or JSON file uploaded by the team, or a public HTTPS link. A direct data link is downloaded and profiled; a page with compatible downloads presents the discovered files for selection. The original source URL remains associated with the future import.
