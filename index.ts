#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// SQLite database file used for persistent storage.
export const defaultMemoryPath = path.join(moduleDir, 'memory.db');

// Resolve the SQLite database path. MEMORY_FILE_PATH may still point at a
// legacy JSONL document from earlier versions; in that case we redirect the
// database to a sibling .db file and import the JSONL contents on first open.
export async function ensureMemoryFilePath(): Promise<string> {
  let resolved: string;
  if (process.env.MEMORY_FILE_PATH) {
    // Custom path provided, use it as-is (with absolute path resolution)
    resolved = path.isAbsolute(process.env.MEMORY_FILE_PATH)
      ? process.env.MEMORY_FILE_PATH
      : path.join(moduleDir, process.env.MEMORY_FILE_PATH);
  } else {
    resolved = defaultMemoryPath;
  }

  if (/\.jsonl?$/i.test(resolved)) {
    const dbPath = resolved.replace(/\.jsonl?$/i, '.db');
    console.error(`DETECTED: ${resolved} is a legacy JSONL memory file; the SQLite database will be created at ${dbPath} and the JSONL contents imported on first start`);
    return dbPath;
  }
  return resolved;
}

// Initialize memory file path (will be set during startup)
let MEMORY_FILE_PATH: string;

// We are storing our memory using entities, relations, and observations in a graph structure
export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// The KnowledgeGraphManager class contains all operations to interact with the
// knowledge graph, backed by a SQLite database (node:sqlite, built into
// Node.js >= 22.13). Mutations run inside transactions so the graph is never
// left half-written.
export class KnowledgeGraphManager {
  private db: DatabaseSync;

  constructor(private memoryFilePath: string) {
    mkdirSync(path.dirname(this.memoryFilePath), { recursive: true });
    const dbExisted = existsSync(this.memoryFilePath);
    this.db = new DatabaseSync(this.memoryFilePath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS entities (
        name TEXT PRIMARY KEY,
        entityType TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        entityName TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE,
        content TEXT NOT NULL,
        PRIMARY KEY (entityName, content)
      );
      CREATE TABLE IF NOT EXISTS relations (
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        relationType TEXT NOT NULL,
        PRIMARY KEY ("from", "to", relationType)
      );
      -- The observations PK (entityName, content) already covers entityName
      -- lookups and the relations PK ("from", "to", relationType) already
      -- covers "from" lookups, so the standalone indexes on those columns are
      -- redundant write overhead; only the "to" index adds a new lookup path.
      DROP INDEX IF EXISTS idx_observations_entityName;
      DROP INDEX IF EXISTS idx_relations_from;
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations("to");

      -- FTS5 trigram search index over entity names, entity types, and
      -- observation content, kept in sync by the triggers below. The trigram
      -- tokenizer gives literal substring matching (the old LIKE '%q%'
      -- semantics) at index speed. Two kinds of rows, disambiguated by the
      -- unindexed kind column (stored, never matched):
      --   kind='entity'      one row per entity, content ''
      --   kind='observation' one row per observation
      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        name,
        entityType,
        content,
        kind UNINDEXED,
        tokenize = 'trigram'
      );
      CREATE TRIGGER IF NOT EXISTS search_index_entities_ai AFTER INSERT ON entities BEGIN
        INSERT INTO search_index (name, entityType, content, kind) VALUES (new.name, new.entityType, '', 'entity');
      END;
      CREATE TRIGGER IF NOT EXISTS search_index_entities_ad AFTER DELETE ON entities BEGIN
        DELETE FROM search_index WHERE name = old.name;
      END;
      CREATE TRIGGER IF NOT EXISTS search_index_entities_au AFTER UPDATE OF name, entityType ON entities BEGIN
        UPDATE search_index SET name = new.name, entityType = new.entityType WHERE name = old.name AND kind = 'entity';
      END;
      CREATE TRIGGER IF NOT EXISTS search_index_observations_ai AFTER INSERT ON observations BEGIN
        INSERT INTO search_index (name, entityType, content, kind) VALUES (new.entityName, '', new.content, 'observation');
      END;
      CREATE TRIGGER IF NOT EXISTS search_index_observations_ad AFTER DELETE ON observations BEGIN
        DELETE FROM search_index WHERE name = old.entityName AND content = old.content AND kind = 'observation';
      END;
      CREATE TRIGGER IF NOT EXISTS search_index_observations_au AFTER UPDATE OF entityName, content ON observations BEGIN
        UPDATE search_index SET name = new.entityName, content = new.content
        WHERE name = old.entityName AND content = old.content AND kind = 'observation';
      END;
    `);
    // One-time backfill of the search index for databases created before it
    // existed; later writes are mirrored into the index by the triggers above.
    this.backfillSearchIndex();
    if (!dbExisted) {
      this.importLegacyJsonl();
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Import legacy JSONL data (memory.jsonl / memory.json) into the database.
  // Only called when the database file did not exist yet, so existing SQLite
  // data is never touched. The legacy file is left in place as a backup.
  private importLegacyJsonl(): void {
    const ext = path.extname(this.memoryFilePath);
    const base = this.memoryFilePath.slice(0, this.memoryFilePath.length - ext.length);
    const candidates = [`${base}.jsonl`, `${base}.json`];

    for (const legacyPath of candidates) {
      let content: string;
      try {
        content = readFileSync(legacyPath, 'utf-8');
      } catch {
        continue; // no legacy file at this path
      }
      const lines = content.split('\n').filter(line => line.trim() !== '');
      if (lines.length === 0) continue;

      const insertEntity = this.db.prepare('INSERT OR IGNORE INTO entities (name, entityType) VALUES (?, ?)');
      const insertObservation = this.db.prepare('INSERT OR IGNORE INTO observations (entityName, content) VALUES (?, ?)');
      const insertRelation = this.db.prepare('INSERT OR IGNORE INTO relations ("from", "to", relationType) VALUES (?, ?, ?)');

      let entities = 0;
      let relations = 0;
      this.db.exec('BEGIN');
      try {
        for (const line of lines) {
          const item = JSON.parse(line);
          if (item.type === 'entity') {
            insertEntity.run(item.name, item.entityType);
            for (const observation of item.observations ?? []) {
              insertObservation.run(item.name, observation);
            }
            entities++;
          } else if (item.type === 'relation') {
            insertRelation.run(item.from, item.to, item.relationType);
            relations++;
          }
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      console.error(`MIGRATED: imported ${entities} entities and ${relations} relations from legacy JSONL file ${legacyPath} into SQLite database ${this.memoryFilePath}`);
      return;
    }
  }

  // One-time backfill of the FTS5 search index for databases that predate it.
  // Guarded by PRAGMA user_version so it runs only once per database; the
  // marker is set in the same transaction as the backfill, so a crash leaves
  // the database clean for a retry on the next open.
  private backfillSearchIndex(): void {
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (user_version >= 1) return;
    this.transaction(() => {
      this.db.exec(`
        INSERT INTO search_index (name, entityType, content, kind)
          SELECT e.name, e.entityType, '', 'entity' FROM entities e;
        INSERT INTO search_index (name, entityType, content, kind)
          SELECT o.entityName, '', o.content, 'observation' FROM observations o;
      `);
      this.db.exec('PRAGMA user_version = 1');
    });
  }

  private loadEntities(names?: string[]): Entity[] {
    const list = names ?? [];
    if (names !== undefined && list.length === 0) return [];
    const whereClause = list.length > 0
      ? ` WHERE name IN (${list.map(() => '?').join(',')})`
      : '';
    const entityRows = this.db.prepare(
      `SELECT name, entityType FROM entities${whereClause} ORDER BY rowid`
    ).all(...list) as { name: string; entityType: string }[];

    const observationWhere = list.length > 0
      ? ` WHERE entityName IN (${list.map(() => '?').join(',')})`
      : '';
    const observationRows = this.db.prepare(
      `SELECT entityName, content FROM observations${observationWhere} ORDER BY rowid`
    ).all(...list) as { entityName: string; content: string }[];

    const observationsByEntity = new Map<string, string[]>();
    for (const row of observationRows) {
      const observations = observationsByEntity.get(row.entityName) ?? [];
      observations.push(row.content);
      observationsByEntity.set(row.entityName, observations);
    }

    return entityRows.map(row => ({
      name: row.name,
      entityType: row.entityType,
      observations: observationsByEntity.get(row.name) ?? [],
    }));
  }

  private loadRelations(names?: string[]): Relation[] {
    const list = names ?? [];
    if (names !== undefined && list.length === 0) return [];
    const whereClause = list.length > 0
      ? ` WHERE "from" IN (${list.map(() => '?').join(',')}) OR "to" IN (${list.map(() => '?').join(',')})`
      : '';
    const params = list.length > 0 ? [...list, ...list] : [];
    const rows = this.db.prepare(
      `SELECT "from", "to", relationType FROM relations${whereClause} ORDER BY rowid`
    ).all(...params);
    return rows.map(row => ({
      from: String(row.from),
      to: String(row.to),
      relationType: String(row.relationType),
    }));
  }

  private graphForEntityNames(names: string[]): KnowledgeGraph {
    if (names.length === 0) {
      return { entities: [], relations: [] };
    }
    return {
      entities: this.loadEntities(names),
      relations: this.loadRelations(names),
    };
  }

  async createEntities(entities: Entity[]): Promise<Entity[]> {
    const insertEntity = this.db.prepare('INSERT OR IGNORE INTO entities (name, entityType) VALUES (?, ?)');
    const insertObservation = this.db.prepare('INSERT OR IGNORE INTO observations (entityName, content) VALUES (?, ?)');
    return this.transaction(() => {
      const newEntities: Entity[] = [];
      for (const entity of entities) {
        if (insertEntity.run(entity.name, entity.entityType).changes > 0) {
          for (const observation of entity.observations) {
            insertObservation.run(entity.name, observation);
          }
          newEntities.push(entity);
        }
      }
      return newEntities;
    });
  }

  async createRelations(relations: Relation[]): Promise<Relation[]> {
    const insertRelation = this.db.prepare('INSERT OR IGNORE INTO relations ("from", "to", relationType) VALUES (?, ?, ?)');
    return this.transaction(() => {
      const newRelations: Relation[] = [];
      for (const relation of relations) {
        if (insertRelation.run(relation.from, relation.to, relation.relationType).changes > 0) {
          newRelations.push(relation);
        }
      }
      return newRelations;
    });
  }

  async addObservations(observations: { entityName: string; contents: string[] }[]): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const findEntity = this.db.prepare('SELECT name FROM entities WHERE name = ?');
    const insertObservation = this.db.prepare('INSERT OR IGNORE INTO observations (entityName, content) VALUES (?, ?)');
    return this.transaction(() => {
      const results = observations.map(o => {
        if (!findEntity.get(o.entityName)) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }
        const addedObservations: string[] = [];
        for (const content of o.contents) {
          if (insertObservation.run(o.entityName, content).changes > 0) {
            addedObservations.push(content);
          }
        }
        return { entityName: o.entityName, addedObservations };
      });
      return results;
    });
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    const deleteRelations = this.db.prepare('DELETE FROM relations WHERE "from" = ? OR "to" = ?');
    const deleteEntity = this.db.prepare('DELETE FROM entities WHERE name = ?');
    this.transaction(() => {
      for (const name of entityNames) {
        deleteRelations.run(name, name);
        deleteEntity.run(name); // observations are removed by ON DELETE CASCADE
      }
    });
  }

  async deleteObservations(deletions: { entityName: string; observations: string[] }[]): Promise<void> {
    const deleteObservation = this.db.prepare('DELETE FROM observations WHERE entityName = ? AND content = ?');
    this.transaction(() => {
      for (const deletion of deletions) {
        for (const observation of deletion.observations) {
          deleteObservation.run(deletion.entityName, observation);
        }
      }
    });
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    const deleteRelation = this.db.prepare('DELETE FROM relations WHERE "from" = ? AND "to" = ? AND relationType = ?');
    this.transaction(() => {
      for (const relation of relations) {
        deleteRelation.run(relation.from, relation.to, relation.relationType);
      }
    });
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return {
      entities: this.loadEntities(),
      relations: this.loadRelations(),
    };
  }

  // Search entity names, entity types, and observation content. The fast path
  // queries the FTS5 trigram index (literal substring match, case-insensitive,
  // same semantics as the old LIKE scan but indexed); queries too short for
  // the trigram tokenizer (< 3 characters) fall back to a LIKE scan.
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const phrase = this.ftsPhrase(query);
    let rows: { name: string }[];
    if (phrase !== null) {
      try {
        rows = this.db.prepare(`
          SELECT DISTINCT e.name
          FROM entities e
          JOIN search_index ON search_index.name = e.name
          WHERE search_index MATCH ?
          ORDER BY e.rowid
        `).all(phrase) as { name: string }[];
      } catch (error) {
        console.error(`FTS search failed for query "${query}", falling back to LIKE scan:`, error);
        rows = this.searchNodesLike(query);
      }
    } else {
      rows = this.searchNodesLike(query);
    }
    return this.graphForEntityNames(rows.map(row => row.name));
  }

  // LIKE scan fallback (the original search implementation), used for queries
  // the trigram tokenizer cannot handle. Note that FTS5 phrase queries are
  // literal, so on the indexed path `%` and `_` in a query no longer act as
  // wildcards as they did in the LIKE scan.
  private searchNodesLike(query: string): { name: string }[] {
    const pattern = `%${query.toLowerCase()}%`;
    return this.db.prepare(`
      SELECT DISTINCT e.name
      FROM entities e
      LEFT JOIN observations o ON o.entityName = e.name
      WHERE LOWER(e.name) LIKE ? OR LOWER(e.entityType) LIKE ? OR LOWER(o.content) LIKE ?
      ORDER BY e.rowid
    `).all(pattern, pattern, pattern) as { name: string }[];
  }

  // Wrap a raw query as an FTS5 phrase for literal substring matching, so FTS5
  // operators in the query cannot change the semantics (a double quote inside
  // the query is escaped by doubling; every other character is literal inside
  // a phrase). Returns null when the query is too short for the trigram
  // tokenizer (needs at least 3 characters), counting code points rather than
  // UTF-16 code units so two astral characters (e.g. emoji) fall back.
  private ftsPhrase(query: string): string | null {
    if ([...query].length < 3) return null;
    return `"${query.replaceAll('"', '""')}"`;
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    return this.graphForEntityNames(names);
  }
}

let knowledgeGraphManager: KnowledgeGraphManager;

// Zod schemas for entities and relations
const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z.array(z.string()).describe("An array of observation contents associated with the entity")
});

const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation")
});

// The server instance and tools exposed to Claude
const server = new McpServer({
  name: "memory-server",
  version: "0.7.0",
});

const RESOURCE_URI = "memory://knowledge-graph";

// Track which resource URIs the connected client has subscribed to, so we only
// emit notifications/resources/updated to a client that asked for them.
const resourceSubscribers = new Set<string>();

// Notify subscribers that the knowledge graph resource changed. No-op when the
// client has not subscribed.
function notifyGraphUpdated() {
  if (resourceSubscribers.has(RESOURCE_URI)) {
    server.server.sendResourceUpdated({ uri: RESOURCE_URI });
  }
}

// Register create_entities tool
server.registerTool(
  "create_entities",
  {
    title: "Create Entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: {
      entities: z.array(EntitySchema)
    },
    outputSchema: {
      entities: z.array(EntitySchema)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }
  },
  async ({ entities }) => {
    const result = await knowledgeGraphManager.createEntities(entities);
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { entities: result }
    };
  }
);

// Register create_relations tool
server.registerTool(
  "create_relations",
  {
    title: "Create Relations",
    description: "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
    inputSchema: {
      relations: z.array(RelationSchema)
    },
    outputSchema: {
      relations: z.array(RelationSchema)
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }
  },
  async ({ relations }) => {
    const result = await knowledgeGraphManager.createRelations(relations);
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { relations: result }
    };
  }
);

// Register add_observations tool
server.registerTool(
  "add_observations",
  {
    title: "Add Observations",
    description: "Add new observations to existing entities in the knowledge graph",
    inputSchema: {
      observations: z.array(z.object({
        entityName: z.string().describe("The name of the entity to add the observations to"),
        contents: z.array(z.string()).describe("An array of observation contents to add")
      }))
    },
    outputSchema: {
      results: z.array(z.object({
        entityName: z.string(),
        addedObservations: z.array(z.string())
      }))
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    }
  },
  async ({ observations }) => {
    const result = await knowledgeGraphManager.addObservations(observations);
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { results: result }
    };
  }
);

// Register delete_entities tool
server.registerTool(
  "delete_entities",
  {
    title: "Delete Entities",
    description: "Delete multiple entities and their associated relations from the knowledge graph",
    inputSchema: {
      entityNames: z.array(z.string()).describe("An array of entity names to delete")
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }
  },
  async ({ entityNames }) => {
    await knowledgeGraphManager.deleteEntities(entityNames);
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: "Entities deleted successfully" }],
      structuredContent: { success: true, message: "Entities deleted successfully" }
    };
  }
);

// Register delete_observations tool
server.registerTool(
  "delete_observations",
  {
    title: "Delete Observations",
    description: "Delete specific observations from entities in the knowledge graph",
    inputSchema: {
      deletions: z.array(z.object({
        entityName: z.string().describe("The name of the entity containing the observations"),
        observations: z.array(z.string()).describe("An array of observations to delete")
      }))
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }
  },
  async ({ deletions }) => {
    await knowledgeGraphManager.deleteObservations(deletions);
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: "Observations deleted successfully" }],
      structuredContent: { success: true, message: "Observations deleted successfully" }
    };
  }
);

// Register delete_relations tool
server.registerTool(
  "delete_relations",
  {
    title: "Delete Relations",
    description: "Delete multiple relations from the knowledge graph",
    inputSchema: {
      relations: z.array(RelationSchema).describe("An array of relations to delete")
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string()
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    }
  },
  async ({ relations }) => {
    await knowledgeGraphManager.deleteRelations(relations);
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: "Relations deleted successfully" }],
      structuredContent: { success: true, message: "Relations deleted successfully" }
    };
  }
);

// Register read_graph tool
server.registerTool(
  "read_graph",
  {
    title: "Read Graph",
    description: "Read the entire knowledge graph",
    inputSchema: {},
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
  },
  async () => {
    const graph = await knowledgeGraphManager.readGraph();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

// Register search_nodes tool
server.registerTool(
  "search_nodes",
  {
    title: "Search Nodes",
    description: "Search for nodes in the knowledge graph based on a query",
    inputSchema: {
      query: z.string().describe("The search query to match against entity names, types, and observation content")
    },
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
  },
  async ({ query }) => {
    const graph = await knowledgeGraphManager.searchNodes(query);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

// Register open_nodes tool
server.registerTool(
  "open_nodes",
  {
    title: "Open Nodes",
    description: "Open specific nodes in the knowledge graph by their names",
    inputSchema: {
      names: z.array(z.string()).describe("An array of entity names to retrieve")
    },
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema)
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
  },
  async ({ names }) => {
    const graph = await knowledgeGraphManager.openNodes(names);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph }
    };
  }
);

export function registerKnowledgeGraphResource(
  server: McpServer,
  manager: KnowledgeGraphManager,
) {
  server.registerResource(
    "knowledge-graph",
    RESOURCE_URI,
    {
      title: "Knowledge Graph",
      description: "The full knowledge graph with all entities and relations",
      mimeType: "application/json",
    },
    async (uri) => {
      const graph = await manager.readGraph();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(graph, null, 2),
          },
        ],
      };
    },
  );
}

// Enable clients to subscribe to the knowledge-graph resource and receive
// notifications/resources/updated when mutation tools change the graph.
export function registerKnowledgeGraphSubscriptions(server: McpServer) {
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    resourceSubscribers.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    resourceSubscribers.delete(request.params.uri);
    return {};
  });
}

async function main() {
  MEMORY_FILE_PATH = await ensureMemoryFilePath();
  knowledgeGraphManager = new KnowledgeGraphManager(MEMORY_FILE_PATH);
  registerKnowledgeGraphResource(server, knowledgeGraphManager);
  registerKnowledgeGraphSubscriptions(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
