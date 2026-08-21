# mcp-server-memory

MCP server exposing a knowledge-graph memory (entities, relations, observations)
as tools and a resource. A fork of the Model Context Protocol reference memory
server, backed by SQLite via `node:sqlite` (requires Node >= 24) instead
of an in-memory JSONL document.

## Data model

- `entities(name PK, entityType)` — observations cascade-delete with the entity.
- `observations(entityName, content, PK(entityName, content))` — FK to entities.
- `relations(from, to, relationType, PK(from, to, relationType))` — no FK.
- `created_at` / `updated_at` — TEXT ISO-8601 UTC provenance columns on
  `entities`, `observations`, and `relations`, stamped by the application on
  insert (`new Date().toISOString()`). Nothing updates rows in place yet, so
  `updated_at` equals `created_at` until in-place mutation is introduced.
- `source` / `session` — nullable TEXT provenance columns on the same three
  tables, captured from the MCP layer: `source` is the client name from the
  `initialize` handshake (`server.server.getClientVersion()?.name`), `session`
  is the transport session id (`extra.sessionId`, NULL over the stdio
  transport). Stamped on insert alongside the timestamps; legacy JSONL imports
  and rows written before this feature leave them NULL.
- `search_index` — FTS5 virtual table (`tokenize = 'trigram'`) over entity
  names, entity types, and observation content, kept in sync by the
  `search_index_*` triggers on `entities` and `observations`. Two row kinds,
  disambiguated by an unindexed `kind` column so it never affects MATCH:
  `kind='entity'` (one row per entity, content `''`) and `kind='observation'`
  (one row per observation). The unindexed column is what makes empty
  observation strings deletable without clobbering the entity row.

`searchNodes` fast path: `search_index MATCH '"<phrase>"'` — literal substring
match, case-insensitive, at index speed. The query is always wrapped in a
double-quoted phrase with embedded quotes doubled, so FTS5 operators cannot
change the semantics. On this path `%` and `_` are literal (they were LIKE
wildcards in the old scan) and diacritics are folded (trigram default:
`"cafe"` matches `"café"`). Queries shorter than 3 characters (the trigram
tokenizer minimum, counted as code points) fall back to a LIKE scan
(`searchNodesLike`), which retains the original wildcard behavior; MATCH
errors (pathological input, e.g. NUL) also fall back.

Schema versioning uses `sqlite-up`: numbered migration files in `migrations/`
(`001_initial_schema.ts`, `002_add_timestamps.ts`, `003_add_provenance.ts`) are applied in order on
open by `lib/migrate.ts`, each batch wrapped in a transaction. Applied
migrations are recorded in the `schema_migrations` table; a fresh database
runs every migration, an existing one runs only those not yet recorded. The
schema bootstrap (tables, FTS index, triggers) lives in migration 001, which
drops and rebuilds `search_index` so it reconciles databases that predate the
`kind` discriminator column. `KnowledgeGraphManager` must be constructed via
the async `open()` factory, not `new`, so migrations finish first. The legacy
JSONL import runs after migrations on a fresh database and populates the index
through the triggers.

## Commands

- `npm run build` / `npx tsc` — compile to `dist/`
- `npm test` / `npx vitest run` — full test suite
- `npm run watch` — `tsc --watch`

## Gotchas

- `node:sqlite` must have FTS5 with the trigram tokenizer; the server fails at
  startup otherwise. Verified on nixpkgs `nodejs-slim-24.19.0` (SQLite
  3.51.2); Node >= 24 is required by `sqlite-up`.
- Behavior change vs. the old LIKE search: `%` and `_` in a query are literal
  on the indexed path (FTS5 phrase), not wildcards; the < 3-char LIKE fallback
  keeps wildcard behavior, so results for such queries can differ.
- Importing `index.ts` / `dist/index.js` under vitest runs module-scope
  `main()`, which opens and migrates the root scratch `memory.db` (gitignored)
  and attempts a stdio connection. Harmless for tests, but the scratch database
  is touched by every test run.
- The standalone indexes `idx_observations_entityName` and `idx_relations_from`
  are redundant — the observations PK `(entityName, content)` and the relations
  PK `("from","to",relationType)` already cover those prefix lookups — and are
  dropped on open. Only `idx_relations_to` is kept.
- The root `memory.db` is an empty scratch artifact (gitignored: `*.db`). The
  real database path comes from `MEMORY_FILE_PATH`; a legacy `.jsonl`/`.json`
  path is redirected to a sibling `.db` and imported on first open.
- Migration filenames are recorded verbatim by `sqlite-up` (`.ts` under source,
  `.js` under compiled `dist/`). Opening the *same* database file from both
  modes (e.g. a fixed `MEMORY_FILE_PATH` shared between `tsx`/vitest and
  `node dist/index.js`) would make the other mode's migrations look pending and
  re-run them, failing on `duplicate column name`. The default paths differ
  (`memory.db` vs `dist/memory.db`), so this does not arise in normal use.
