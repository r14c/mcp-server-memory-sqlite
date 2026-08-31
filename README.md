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
  "observations": [
    "Speaks fluent Spanish",
    "Graduated in 2019",
    "Prefers morning meetings"
  ]
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
  - Silent operation if entity doesn't exist

- **delete_observations**
  - Remove specific observations from entities
  - Input: `deletions` (array of objects)
    - Each object contains:
      - `entityName` (string): Target entity
      - `observations` (string[]): Observations to remove
  - Silent operation if observation doesn't exist

- **delete_relations**
  - Remove specific relations from the graph
  - Input: `relations` (array of objects)
    - Each object contains:
      - `from` (string): Source entity name
      - `to` (string): Target entity name
      - `relationType` (string): Relationship type
  - Silent operation if relation doesn't exist

- **read_graph**
  - Read the entire knowledge graph
  - No input required
  - Returns complete graph structure with all entities and relations

- **search_nodes**
  - Search for nodes based on query
  - Input: `query` (string)
  - Searches across:
    - Entity names
    - Entity types
    - Observation content
  - Returns matching entities and their relations

- **open_nodes**
  - Retrieve specific nodes by name
  - Input: `names` (string[])
  - Returns:
    - Requested entities
    - Relations between requested entities
  - Silently skips non-existent nodes

### Resources

- **knowledge-graph** (`memory://knowledge-graph`)
  - The full knowledge graph as a readable MCP Resource
  - MIME type: `application/json`
  - Returns the same shape as `read_graph` (entities and relations)
  - Mutation tools (`create_entities`, `create_relations`, `add_observations`,
    `delete_entities`, `delete_observations`, `delete_relations`) emit
    `notifications/resources/updated` for this URI, so subscribed clients see
    live changes

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

### Large responses: server-side curation

`search_nodes`, `read_graph`, and `open_nodes` return the *full* graph of
matches — entities with all their observations, plus every relation touching
them (the upstream drop-in contract). On a realistic graph the serialized tool
result is large: 50–100 KiB per search on a live graph. Some MCP clients bound
the tool results they expose to the model: the pi coding agent's adapter
(`pi-mcp-adapter`) replaces any tool result whose JSON exceeds its
`detailsMaxBytes` (default **16 KiB**) with an `{ omitted: true }` summary that
has no `entities`/`relations` keys — so on the mcpScript/worker call path a
large search appeared to return "no results".

To keep responses usable, this server **curates** graph responses: the result
is deep-truncated so the serialized tool result fits within the same budget the
adapter enforces by default. Truncation preserves the top-level
`{ entities, relations }` shape and is applied in stages — observation text
length, then observations per entity, then relations, then entities — keeping
the head of each list and, for `search_nodes`, preferring observations that
match the query. When data was cut, the response carries a `truncated` field
with the byte budget and the counts dropped (entities / observations /
relations, plus a flag when observation text was shortened). Results that
already fit pass through unchanged.

The budget is configurable:

- `MEMORY_RESPONSE_MAX_BYTES` — max serialized tool-result size in bytes
  (default `16384`, matching pi-mcp-adapter's `detailsMaxBytes` default; `0`
  disables curation).

Caveats:

- Truncation is lossy by design; the SQLite database is always the source of
  truth. Narrower `search_nodes` queries, or `open_nodes` on fewer names,
  return more of the graph.
- Budgets below a few hundred bytes cannot fit even the most aggressively
  trimmed response (one entity, one short observation); the smallest possible
  result is delivered regardless.
- If you raise the client-side cap (pi: `settings.outputGuard.detailsMaxBytes`
  in `mcp.json` — note that setting is global for all servers), raise
  `MEMORY_RESPONSE_MAX_BYTES` to match, or results are truncated more than the
  client would allow.
- The `truncated` key is additive to the frozen upstream
  `{ entities, relations }` schema and appears only when data was dropped.

The behavior is pinned by `__tests__/curation.test.ts` (hermetic),
`__tests__/output-guard.test.ts` (hermetic), and
`__tests__/pi-adapter-output-guard.integration.test.ts` (against the real
adapter, skipped when it is not installed).

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
