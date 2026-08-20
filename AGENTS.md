# mcp-server-memory

MCP server exposing a knowledge-graph memory (entities, relations, observations)
as tools and a resource. A fork of the Model Context Protocol reference memory
server, backed by SQLite via `node:sqlite` (built into Node >= 22.13) instead
of an in-memory JSONL document.

## Data model

- `entities(name PK, entityType)` — observations cascade-delete with the entity.
- `observations(entityName, content, PK(entityName, content))` — FK to entities.
- `relations(from, to, relationType, PK(from, to, relationType))` — no FK.
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

Schema versioning uses `PRAGMA user_version`: 0 = pre-search-index, 1 =
current. On open, `backfillSearchIndex()` backfills the index from `entities` +
`observations` inside one transaction that also sets the marker, so a crash
leaves the database clean for a retry. The legacy JSONL import runs after the
backfill and populates the index through the triggers.

## Commands

- `npm run build` / `npx tsc` — compile to `dist/`
- `npm test` / `npx vitest run` — full test suite
- `npm run watch` — `tsc --watch`

## Gotchas

- `node:sqlite` must have FTS5 with the trigram tokenizer; the server fails at
  startup otherwise. Verified on nixpkgs `nodejs-slim-22.23.2` and
  `nodejs-slim-24.19.0` (both SQLite 3.51.2).
- Behavior change vs. the old LIKE search: `%` and `_` in a query are literal
  on the indexed path (FTS5 phrase), not wildcards; the < 3-char LIKE fallback
  keeps wildcard behavior, so results for such queries can differ.
- Importing `index.ts` / `dist/index.js` under vitest runs module-scope `main()`
  which calls `process.exit(1)`; vitest reports two unhandled rejections but
  every test passes. Pre-existing, unrelated to this change.
- The standalone indexes `idx_observations_entityName` and `idx_relations_from`
  are redundant — the observations PK `(entityName, content)` and the relations
  PK `("from","to",relationType)` already cover those prefix lookups — and are
  dropped on open. Only `idx_relations_to` is kept.
- The root `memory.db` is an empty scratch artifact (gitignored: `*.db`). The
  real database path comes from `MEMORY_FILE_PATH`; a legacy `.jsonl`/`.json`
  path is redirected to a sibling `.db` and imported on first open.

