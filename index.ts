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
      CREATE INDEX IF NOT EXISTS idx_observations_entityName ON observations(entityName);
      CREATE INDEX IF NOT EXISTS idx_relations_from ON relations("from");
      CREATE INDEX IF NOT EXISTS idx_relations_to ON relations("to");
    `);
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

  // Very basic search function
  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const pattern = `%${query.toLowerCase()}%`;
    const rows = this.db.prepare(`
      SELECT DISTINCT e.name
      FROM entities e
      LEFT JOIN observations o ON o.entityName = e.name
      WHERE LOWER(e.name) LIKE ? OR LOWER(e.entityType) LIKE ? OR LOWER(o.content) LIKE ?
      ORDER BY e.rowid
    `).all(pattern, pattern, pattern) as { name: string }[];

    return this.graphForEntityNames(rows.map(row => row.name));
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
