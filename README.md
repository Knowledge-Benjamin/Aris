# Aris — Digital Brain

A full-stack digital brain architecture powered by Gemma 4, with a clean CLI interface and persistent PostgreSQL memory.

## Architecture

- `server/` — Express backend with memory persistence and Gemma advisor integration
- `cli/` — terminal-based CLI interaction layer
- `database` — PostgreSQL memory store (Neon-compatible via `DATABASE_URL`)

## Getting started

1. Copy `.env.example` to `.env` and fill in your Neon Postgres connection string.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Initialize the database:
   ```bash
   npm run db:setup
   ```
4. Start the server and CLI:
   ```bash
   npm run dev
   ```

## Notes

- `Aris` is designed to be the architectural brain and memory manager.
- `Gemma 4` is used as an advisor layer via the backend service.
- The backend uses the Gemma Generative Language API endpoint at `https://generativelanguage.googleapis.com/v1beta`.
- Supported Gemma 4 models include `gemma-4-26b-a4b-it` and `gemma-4-31b-it`.
- Memory is persistent and intended to evolve over time.
- If you use `pg@8.21+`, make sure your `DATABASE_URL` includes an explicit SSL mode:
  - `?sslmode=verify-full` for current secure behavior
  - or `?uselibpqcompat=true&sslmode=require` if you need libpq compatibility
