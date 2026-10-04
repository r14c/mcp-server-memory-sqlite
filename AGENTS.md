# mcp-server-memory

MCP server exposing a knowledge-graph memory (entities, relations, observations)
as tools and a resource. A fork of the Model Context Protocol reference memory
server, backed by SQLite via `node:sqlite` (requires Node >= 24) instead
of an in-memory JSONL document. Upstream's nine tools keep their upstream
signatures — a caller written against upstream works unchanged — and this fork
adds a tenth (`update_observations`) plus extra response fields where
upstream's shape makes the graph hard to work with. Behavior diverges
deliberately for correctness: dangling relations are rejected, entity names are
case-insensitive, inverse relations are materialized on write, deletes report
what matched, and relation endpoints come back as `neighbors`.

## Data model

- `entities(name PK, entityType)` — names compare case-insensitively via a
  `COLLATE NOCASE` unique index (migration 004): first-seen casing is
  preserved, later case-variants dedupe. Observations cascade-delete with the
  entity.
- `observations(entityName, content, PK(entityName, content))` — FK to entities.
- `relations(from, to, relationType, PK(from, to, relationType))` — `from`/`to`
  FK to `entities(name) ON DELETE CASCADE`, declared `DEFERRABLE INITIALLY
DEFERRED` (migrations 005 + 006). The deferred declaration moves the FK
  check from statement end to the enclosing transaction's COMMIT, so within
  one transaction a relation may be inserted before its endpoint entity
  exists; a genuinely dangling edge still fails at COMMIT and rolls back the
  whole transaction. Writes resolve endpoint names to their canonical casing
  first; the FK rejects dangling edges as a backstop.
- `relation_semantics` (a code constant in `lib/ontology.ts`, not a table)
  declares inverse pairs and transitivity for a curated relation vocabulary.
  Inverses are materialized on write (`create_relations` also writes the
  inverse edge) and removed together on delete, keeping the graph
  directionally closed. `transitive` is metadata only, for a future traversal
  consumer.
- `created_at` / `updated_at` — TEXT ISO-8601 UTC provenance columns on
  `entities`, `observations`, and `relations`, stamped by the application on
  insert (`new Date().toISOString()`). Observations are the one thing updated in
  place (via `update_observations`), so their `updated_at` can exceed
  `created_at`; every other row still has them equal.
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
(`001_initial_schema.ts`, `002_add_timestamps.ts`, `003_add_provenance.ts`,
`004_nocase_entity_identity.ts`, `005_relation_foreign_keys.ts`,
`006_deferred_relation_foreign_keys.ts`) are applied in
order on open by `lib/migrate.ts`, each batch wrapped in a transaction. Applied
migrations are recorded in the `schema_migrations` table; a fresh database
runs every migration, an existing one runs only those not yet recorded. The
schema bootstrap (tables, FTS index, triggers) lives in migration 001, which
drops and rebuilds `search_index` so it reconciles databases that predate the
`kind` discriminator column. Migration 006 rebuilds `relations` with the
`DEFERRABLE INITIALLY DEFERRED` foreign keys; migration 005 (which added the
FKs and canonicalized/dropped dangling edges) must run first, so the 006 copy
is a straight one. `KnowledgeGraphManager` must be constructed via the
async `open()` factory, not `new`, so migrations finish first. The legacy
JSONL import runs after migrations on a fresh database and populates the index
through the triggers.

## Module layout

- `index.ts` — entry point; re-exports the public surface and runs `main()`.
- `lib/manager.ts` — `KnowledgeGraphManager` (SQLite operations).
- `lib/server.ts` — `buildServer` + the ten tool registrations, the resource, and subscriptions.
- `lib/migrate.ts` — sqlite-up migration runner.
- `lib/types.ts` / `lib/ontology.ts` / `lib/paths.ts` — types, relation vocabulary, path resolution.
- `lib/web/` — the HTMX browser/editor. `html.ts` (escaping + page shell),
  `fragments.ts` (pure panels), `routes.ts` (`@koa/router` table), `server.ts`
  (`createApp`/`startWebServer`, same-origin guard, htmx asset). It drives the
  same `KnowledgeGraphManager` the MCP tools do: no SQL, no schema, no types of
  its own. `web.ts` (root) is its bin, `mcp-server-memory-web`.

## Commands

- `npm run build` / `npx tsc` — compile to `dist/`
- `npm test` / `npx vitest run` — full test suite
- `npm run watch` — `tsc --watch`
- `npm run web` — build and serve the web UI on `127.0.0.1:3939` (`PORT`,
  `HOST`, `MEMORY_FILE_PATH`)

## Gotchas

- `update_observations` is the only in-place mutation: it UPDATEs the
  observation row, so `created_at` survives and `updated_at` moves (elsewhere
  `updated_at` still equals `created_at`). It is addressed by exact content and
  throws on an absent match, on an unknown entity, or on a replacement that
  already exists on that entity (including a replacement identical to the
  match, which would otherwise report a no-op as an edit). The batch is atomic.
- Relation endpoints outside the requested/matched set come back as `neighbors`
  on `search_nodes` and `open_nodes`: the far endpoints of the returned
  relations, deduped, in rowid order, empty when the result set is closed.
  `read_graph` loads every entity, so its `neighbors` is always empty.
- A delete reports what matched — `deletedEntities`,
  `results[].deletedObservations`, `deletedRelations`, plus a "Deleted N of M
  requested" message — and stays idempotent (a target that is already gone is
  not an error). The materialized inverse is removed only when the requested
  edge matched, and is never reported as a separate deletion.

- `node:sqlite` must have FTS5 with the trigram tokenizer; the server fails at
  startup otherwise. Verified on nixpkgs `nodejs-slim-24.19.0` (SQLite
  3.51.2); Node >= 24 is required by `sqlite-up`.
- Behavior change vs. the old LIKE search: `%` and `_` in a query are literal
  on the indexed path (FTS5 phrase), not wildcards; the < 3-char LIKE fallback
  keeps wildcard behavior, so results for such queries can differ.
- `index.ts` runs `main()` only under `if (import.meta.main)`, so importing the
  package root is inert (tests import it for the re-exports without opening a
  database or a stdio transport). The check needs Node >= 24.2.0 — see the
  `engines` field; on older runtimes `import.meta.main` is undefined and the
  server would silently never start.
- The standalone indexes `idx_observations_entityName` and `idx_relations_from`
  are redundant — the observations PK `(entityName, content)` and the relations
  PK `("from","to",relationType)` already cover those prefix lookups — and are
  dropped on open. Only `idx_relations_to` is kept.
- The default database path is a scratch artifact beside the compiled entry
  point: `dist/memory.db` for `node dist/index.js` / `node dist/web.js`, and the
  repo root under source (gitignored: `*.db`). The real database path comes from
  `MEMORY_FILE_PATH`, which resolves **relative** values against that same
  directory rather than the shell's cwd — so `MEMORY_FILE_PATH=./memory.db`
  under the built bin silently means `dist/memory.db`, and only an absolute path
  (or `../memory.db`) reaches the repo root. A legacy `.jsonl`/`.json` path is
  redirected to a sibling `.db` and imported on first open.
- Entity identity (`COLLATE NOCASE`) folds ASCII case only, while the FTS5
  trigram index folds diacritics too — so `"Café"` and `"café"` are distinct
  entities that both surface in search. Identity does not trim whitespace.
- Migration filenames are recorded verbatim by `sqlite-up` (`.ts` under source,
  `.js` under compiled `dist/`). Opening the _same_ database file from both
  modes (e.g. a fixed `MEMORY_FILE_PATH` shared between `tsx`/vitest and
  `node dist/index.js`) would make the other mode's migrations look pending and
  re-run them, failing on `duplicate column name`. The default paths differ
  (`memory.db` vs `dist/memory.db`), so this does not arise in normal use.
- The web UI answers every mutation with **200**, even when the manager rejected
  the write: htmx only swaps 2xx bodies, so a failure travels as a banner inside
  the re-rendered panel. The `error.message` in it is the manager's, verbatim.
- Entity names reach the panels through query strings and hidden form fields, so
  every interpolation must go through `escapeHtml` (`encodeURIComponent` in a
  URL); `nodePanel` compares names **exactly**, so routes canonicalize a name via
  the `openNodes` result first — a case-variant request would otherwise render
  the not-found view, whose create form the NOCASE identity rejects as a
  duplicate.
- The web UI is loopback-only and unauthenticated. It answers loopback `Host`
  headers only (that is what closes DNS rebinding — an Origin check alone is
  defeated by a page that rebinds a domain it controls to 127.0.0.1, since that
  page is same-origin with the name it used), and non-GET/HEAD requests need a
  same-origin `Origin` (no Origin at all is allowed, for curl). `HX-Trigger:
  graph-changed` is what refreshes the index pane after a write.
