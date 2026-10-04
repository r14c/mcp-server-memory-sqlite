# Knowledge Graph Memory Server

A basic implementation of persistent memory using a local knowledge graph. This
lets AI assistants remember information about the user across chats.

## Core Concepts

### Entities

Entities are the primary nodes in the knowledge graph. Each entity has:

- A unique name (identifier)
- An entity type (e.g., "person", "organization", "event")
- A list of observations

Example:

```json
{
  "name": "Jaime_Villanueve",
  "entityType": "person",
  "observations": ["Speaks fluent Spanish"]
}
```

### Relations

Relations define directed connections between entities. They are always stored
in active voice and describe how entities interact or relate to each other.

Example:

```json
{
  "from": "Jaime_Chicharra",
  "to": "Anthropic",
  "relationType": "works_at"
}
```

### Observations

Observations are discrete pieces of information about an entity. They are:

- Stored as strings
- Attached to specific entities
- Can be added or removed independently
- Should be atomic (one fact per observation)

Example:

```json
{
  "entityName": "Jaime_Chicharra",
  "observations": ["Speaks fluent Spanish", "Graduated in 2019", "Prefers morning meetings"]
}
```

## Storage

The knowledge graph is stored in a local SQLite database using Node's built-in
`node:sqlite` module — no native dependencies, requires Node.js >= 24. The
database contains three tables:

- `entities` — `name` (primary key) and `entityType`
- `observations` — one row per observation, linked to its entity by
  `entityName`; removed automatically when the entity is deleted
- `relations` — `from`, `to`, and `relationType` (primary key across all three)

All mutation operations run inside transactions, so the graph is never left in a
half-written state.

### Migrating from JSONL

Versions before 0.7.0 stored the graph as a JSONL document (`memory.jsonl`). On
first start with an empty database, the server automatically imports entities
and relations from a legacy JSONL file next to the database (e.g. `memory.jsonl`
or `memory.json` next to `memory.db`) and logs what it imported. The legacy file
is left in place as a backup.

If `MEMORY_FILE_PATH` still points at a `.jsonl`/`.json` file, the server
redirects the database to the sibling `.db` path and imports the legacy contents
on first start.

## API

this MCP server is designed as a drop-in replacement for
[mcp-server-memory](https://www.npmjs.com/package/@modelcontextprotocol/server-memory).
we do slightly bend some tools semantric so we can use a stricter schema than
the jsonl file, but our intention is to match the upstream tool call signatures.

A caller written against upstream keeps working: upstream's nine tools keep
their names, inputs, and the response fields they read. On top of that we add
fields and one verb where upstream's shape makes the graph hard to work with —
relations come back with their far endpoints (see `neighbors`), deletes report
what actually matched instead of a blanket success, and `update_observations`
exists because upstream's edit is a delete plus an add: two calls, non-atomic,
and unverifiable.

### Tools

- **create_entities**
  - Create multiple new entities in the knowledge graph
  - Input: `entities` (array of objects)
    - Each object contains:
      - `name` (string): Entity identifier
      - `entityType` (string): Type classification
      - `observations` (string[]): Associated observations
  - Ignores entities with existing names

- **create_relations**
  - Create multiple new relations between entities
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type in active voice
  - Skips duplicate relations

- **add_observations**
  - Add new observations to existing entities
  - Input: `observations` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `contents` (string[]): New observations to add
  - Returns added observations per entity
  - Fails if entity doesn't exist

- **delete_entities**
  - Remove entities and their relations
  - Input: `entityNames` (string[])
  - Cascading deletion of associated relations
  - Returns `deletedEntities`: the canonical names that were actually removed
  - Idempotent: names that do not exist are skipped, not an error

- **delete_observations**
  - Remove specific observations from entities
  - Input: `deletions` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `observations` (string[]): Observations to remove
  - Returns `results`: per entity, the `deletedObservations` that actually
    matched (`message` carries `deleted N of M requested`)
  - Observation content is the primary key, so the match must be exact

- **delete_relations**
  - Remove specific relations from the graph
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type
  - Returns `deletedRelations`: the edges that actually matched
  - A materialized inverse is removed with its primary edge but not reported
    as a separate deletion

- **update_observations**
  - Replace the text of existing observations in place
  - Input: `updates` (array of objects)
    - Each object contains:
      - `entityName` (string): Entity holding the observation
      - `match` (string): The exact current content to replace
      - `replacement` (string): The new content
  - Returns `updatedObservations` per entity
  - The row is updated, not rewritten: `created_at` keeps the first-written
    time and `updated_at` records the edit; the search index follows
  - Fails the whole batch (no partial application) if a `match` is absent, if
    the entity is unknown, or if `replacement` already exists on that entity —
    including when `replacement` equals `match`, since replacing text with
    itself is not an edit

- **read_graph**
  - Read the entire knowledge graph
  - No input required
  - Returns complete graph structure with all entities and relations. Every
    entity is loaded, so there is no frontier: `neighbors` is always empty

- **search_nodes**
  - Search for nodes based on query
  - Input: `query` (string)
  - Searches across:
    - Entity names
    - Entity types
    - Observation content
  - Returns matching entities, their relations, and the relations' far
    endpoints as `neighbors`

- **open_nodes**
  - Retrieve specific nodes by name
  - Input: `names` (string[])
  - Returns:
    - Requested entities
    - Relations touching those entities
    - `neighbors`: the far endpoints of those relations that were not requested
      themselves, so one call returns a node and everything it points at
  - Silently skips non-existent nodes

`search_nodes` and `open_nodes` return `neighbors` (deduped, in rowid order);
the list is empty when a result set is closed, and `read_graph` — which loads
every entity — always returns `[]`.

### Resources

- **knowledge-graph** (`memory://knowledge-graph`)
  - The full knowledge graph as a readable MCP Resource
  - MIME type: `application/json`
  - Returns the same shape as `read_graph` (entities, relations, and an empty
    `neighbors` list)
  - Mutation tools (`create_entities`, `create_relations`, `add_observations`,
    `update_observations`, `delete_entities`, `delete_observations`,
    `delete_relations`) emit `notifications/resources/updated` for this URI, so
    subscribed clients see live changes

## Web UI

A localhost, server-rendered HTMX app for browsing and editing the same
knowledge graph. It is built on the same `KnowledgeGraphManager`, so it shares
the MCP server's migrations, SQLite file, relation vocabulary, and write
semantics — there is no second schema and no second copy of the graph.

```sh
npm run web                          # builds, then serves http://127.0.0.1:3939
PORT=8080 npm run web                # PORT (default 3939) and HOST (default 127.0.0.1)
MEMORY_FILE_PATH=./kg.db npm run web # same resolution rules as the MCP server
```

- search with the server's FTS5 index (`search_nodes` semantics), browse the
  entity index, and open an entity with its observations and both directions of
  its relations
- create and delete entities, add/edit/delete observations in place
  (`update_observations` semantics), and create/delete relations; a declared
  inverse (`part_of` ↔ `contains`) is materialized exactly as it is over MCP
- edits and deletes that match nothing report the manager's own message instead
  of pretending to succeed, and web writes are stamped `source = 'web'`

The server binds to loopback and has no authentication — it is a single-user
local tool, not a service. It answers loopback `Host` headers only, which
closes DNS rebinding (a page on an attacker-controlled domain that resolves to
`127.0.0.1` sends that domain in `Host`), and state-changing requests must also
carry a same-origin `Origin`, which stops any other page you happen to visit
from posting to it. Embedders can widen the allowlist with `allowedHosts`; it is
still not something to expose beyond the loopback interface.

# Usage with MCP clients

### Setup

Add this to your `mcp.json`:

#### Docker

```json
{
  "mcpServers": {
    "memory": {
      "command": "docker",
      "args": ["run", "-i", "-v", "memory-data:/app/dist", "--rm", "mcp/memory"]
    }
  }
}
```

#### NPX

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

On Windows, use `cmd /c` to launch `npx`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

#### NPX with custom setting

The server can be configured using the following environment variables:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/custom/memory.db"
      }
    }
  }
}
```

On Windows, use:

```json
{
  "mcpServers": {
    "memory": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-memory"],
      "env": {
        "MEMORY_FILE_PATH": "/path/to/custom/memory.db"
      }
    }
  }
}
```

- `MEMORY_FILE_PATH`: Path to the memory SQLite database file (default:
  `memory.db` in the server directory). If the path ends in `.jsonl` or `.json`,
  it is treated as a legacy JSONL memory file: the database is created at the
  sibling `.db` path and the JSONL contents are imported on first start.

### Large responses: the server returns the full result

`search_nodes`, `read_graph`, and `open_nodes` return the _full_ graph of
matches — entities with all their observations, plus every relation touching
them and the far endpoints of those relations (`neighbors`). On a realistic
graph the serialized tool result is large: 50–100 KiB per search on a live
graph, and much more for the whole graph. Some MCP clients bound the tool
results they expose to the model: the pi coding agent's adapter
(`pi-mcp-adapter`) replaces any tool result whose JSON exceeds its
`detailsMaxBytes` (default **16 KiB**) with an `{ omitted: true }` summary that
has no `entities`/`relations` keys — so on the mcpScript/worker call path a
large search appeared to return "no results".

The server does **nothing** about this, deliberately: it returns the full
result and leaves the bound to the client. The adapter's guard _spills_ an
oversized result to a temp file (mode 0600) and returns a summary carrying
`fullResultPath`, so the caller can still read everything — whereas a
server-side trim is lossy with no way back to the dropped data. That bound also
fails in a way the guard does not: a board is a single entity, so a
trim keeps the head and the rest of it cannot be reached with a narrower query
at all. An unbounded reply is noisy; a bounded reply that silently drops half a
board is worse.

If a client's cap is too tight, raise it (pi: `settings.outputGuard.
detailsMaxBytes` in `mcp.json` — note that setting is global for all servers),
or read less per call: `open_nodes` on fewer names, a narrower `search_nodes`
query, or `read_graph` piped somewhere the model does not have to hold all of
it.

The behavior is pinned by `__tests__/output-guard.test.ts` (hermetic),
`__tests__/pi-adapter-output-guard.integration.test.ts` (against the real
adapter, skipped when it is not installed), and
`__tests__/pi-client-output-schema.integration.test.ts` (against the real pi
client, likewise skipped).

## Install Instructions

You can configure the MCP server using one of these methods:

**Method 1: User Configuration (Recommended)** Add the configuration to your
user-level MCP configuration file. Open the Command Palette (`Ctrl + Shift + P`)
and run `MCP: Open User Configuration`. This will open your user `mcp.json` file
where you can add the server configuration.

**Method 2: Workspace Configuration** Alternatively, you can add the
configuration to a file called `.vscode/mcp.json` in your workspace. This will
allow you to share the configuration with others.

> For more details about MCP configuration in VS Code, see the
> [official VS Code MCP documentation](https://code.visualstudio.com/docs/copilot/customization/mcp-servers).

#### NPX

```json
{
  "servers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

On Windows, use:

```json
{
  "servers": {
    "memory": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

#### Docker

```json
{
  "servers": {
    "memory": {
      "command": "docker",
      "args": ["run", "-i", "-v", "memory-data:/app/dist", "--rm", "mcp/memory"]
    }
  }
}
```

### System Prompt

The prompt for utilizing memory depends on the use case. Changing the prompt
will help the model determine the frequency and types of memories created.

Here is an example prompt for chat personalization. You can use this prompt as a
system prompt for your AI assistant.

```
Follow these steps for each interaction:

1. User Identification:
   - You should assume that you are interacting with default_user
   - If you have not identified default_user, proactively try to do so.

2. Memory Retrieval:
   - Always begin your chat by saying only "Remembering..." and retrieve all relevant information from your knowledge graph
   - Always refer to your knowledge graph as your "memory"

3. Memory
   - While conversing with the user, be attentive to any new information that falls into these categories:
     a) Basic Identity (age, gender, location, job title, education level, etc.)
     b) Behaviors (interests, habits, etc.)
     c) Preferences (communication style, preferred language, etc.)
     d) Goals (goals, targets, aspirations, etc.)
     e) Relationships (personal and professional relationships up to 3 degrees of separation)

4. Memory Update:
   - If any new information was gathered during the interaction, update your memory as follows:
     a) Create entities for recurring organizations, people, and significant events
     b) Connect them to the current entities using relations
     c) Store facts about them as observations
```

## Building

The server uses Node's built-in `node:sqlite` module, which requires Node.js

> = 24.

Docker:

```sh
docker build -t mcp/memory .
```

For Awareness: the Docker command above persists the server in a named volume
mounted over `/app/dist`. A volume created by a prior image shadows the new
container's `/app/dist`, including the compiled schema migrations at
`/app/dist/migrations`; the server then fails to start with a "Failed to load
migrations" error. If you use a docker volume for storage, delete the old volume
(or at least its contents) before starting the new container so the fresh code
and migrations are used.

## License

This MCP server is licensed under the MIT License. This means you are free to
use, modify, and distribute the software, subject to the terms and conditions of
the MIT License. For more details, please see the LICENSE file in the project
repository.
