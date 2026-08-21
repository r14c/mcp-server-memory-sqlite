#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { applyMigrations } from "./lib/migrate.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// SQLite database file used for persistent storage.
export const defaultMemoryPath = path.join(moduleDir, "memory.db");

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
    const dbPath = resolved.replace(/\.jsonl?$/i, ".db");
    console.error(
      `DETECTED: ${resolved} is a legacy JSONL memory file; the SQLite database will be created at ${dbPath} and the JSONL contents imported on first start`,
    );
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

// Provenance captured from the MCP layer and stamped onto written rows: the
// client identity reported during the initialize handshake, and the transport
// session id (undefined over the stdio transport).
export interface Provenance {
  source?: string;
  session?: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// The KnowledgeGraphManager class contains all operations to interact with the
// knowledge graph, backed by a SQLite database (node:sqlite, requires Node.js
// >= 24). Mutations run inside transactions so the graph is never left
// half-written.
export class KnowledgeGraphManager {
  private db: DatabaseSync;

  // Opens the database and applies pending migrations. The schema is defined in
  // migration files (see migrations/) rather than inline, so a fresh database
  // runs every migration while an existing one runs only those not yet recorded
  // in sqlite-up's schema_migrations table. Use the static open() factory, not
  // new, so migrations and the legacy import complete before the manager is used.
  private constructor(private memoryFilePath: string) {
    mkdirSync(path.dirname(this.memoryFilePath), { recursive: true });
    this.db = new DatabaseSync(this.memoryFilePath);
  }

  static async open(memoryFilePath: string): Promise<KnowledgeGraphManager> {
    const dbExisted = existsSync(memoryFilePath);
    const manager = new KnowledgeGraphManager(memoryFilePath);
    try {
      manager.applyPragmas();
      await manager.runMigrations();
      if (!dbExisted) {
        manager.importLegacyJsonl();
      }
      manager.assertIntegrity();
    } catch (error) {
      // Never leak the open connection if setup fails partway through (e.g. a
      // corrupt file detected by assertIntegrity, a bad legacy import, or a
      // migration that fails to apply).
      try {
        manager.close();
      } catch {
        // Already failing; ignore secondary close errors.
      }
      throw error;
    }
    return manager;
  }

  // Operational pragmas. WAL is append-only and checksummed, which removes
  // the torn-page failure mode of the rollback journal. synchronous=FULL keeps
  // every committed transaction durable across power loss at the cost of write
  // throughput; this server's request volume is low, so durability wins over
  // speed. busy_timeout makes concurrent access wait instead of failing
  // immediately with SQLITE_BUSY. foreign_keys is enabled before any migration
  // runs so FK enforcement is active for the whole lifetime. Applied inside
  // open()'s try so a failure here still closes the connection.
  private applyPragmas(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
    `);
  }

  private async runMigrations(): Promise<void> {
    await applyMigrations(this.db);
  }

  // ISO-8601 UTC timestamp for the created_at/updated_at provenance columns.
  private now(): string {
    return new Date().toISOString();
  }

  close(): void {
    // Fold the WAL back into the main database on clean shutdown and drop the
    // -wal/-shm sidecar files. Best-effort: a failed checkpoint must not
    // prevent the connection from closing. optimize is a cheap no-op unless
    // SQLite decides fresh statistics would help the query planner.
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.db.exec("PRAGMA optimize");
    } catch (error) {
      console.error(`Error finalizing database ${this.memoryFilePath}:`, error);
    }
    this.db.close();
  }

  // Fail fast on open if the database file is corrupt instead of returning
  // silently wrong results later. quick_check is the fast corruption scan
  // (it reads every page once, unlike the slower integrity_check), so startup
  // cost grows with database size but is negligible for typical memory stores.
  private assertIntegrity(): void {
    const { quick_check } = this.db.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (quick_check !== "ok") {
      throw new Error(`SQLite quick_check failed for ${this.memoryFilePath}: ${quick_check}`);
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
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
        content = readFileSync(legacyPath, "utf-8");
      } catch {
        continue; // no legacy file at this path
      }
      const lines = content.split("\n").filter((line) => line.trim() !== "");
      if (lines.length === 0) continue;

      const insertEntity = this.db.prepare(
        "INSERT OR IGNORE INTO entities (name, entityType, created_at, updated_at) VALUES (?, ?, ?, ?)",
      );
      const insertObservation = this.db.prepare(
        "INSERT OR IGNORE INTO observations (entityName, content, created_at, updated_at) VALUES (?, ?, ?, ?)",
      );
      const insertRelation = this.db.prepare(
        'INSERT OR IGNORE INTO relations ("from", "to", relationType, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      );

      const now = this.now();
      let entities = 0;
      let relations = 0;
      this.db.exec("BEGIN");
      try {
        for (const line of lines) {
          const item = JSON.parse(line);
          if (item.type === "entity") {
            insertEntity.run(item.name, item.entityType, now, now);
            for (const observation of item.observations ?? []) {
              insertObservation.run(item.name, observation, now, now);
            }
            entities++;
          } else if (item.type === "relation") {
            insertRelation.run(item.from, item.to, item.relationType, now, now);
            relations++;
          }
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      console.error(
        `MIGRATED: imported ${entities} entities and ${relations} relations from legacy JSONL file ${legacyPath} into SQLite database ${this.memoryFilePath}`,
      );
      return;
    }
  }

  private loadEntities(names?: string[]): Entity[] {
    const list = names ?? [];
    if (names !== undefined && list.length === 0) return [];
    const whereClause = list.length > 0 ? ` WHERE name IN (${list.map(() => "?").join(",")})` : "";
    const entityRows = this.db
      .prepare(`SELECT name, entityType FROM entities${whereClause} ORDER BY rowid`)
      .all(...list) as { name: string; entityType: string }[];

    const observationWhere =
      list.length > 0 ? ` WHERE entityName IN (${list.map(() => "?").join(",")})` : "";
    const observationRows = this.db
      .prepare(`SELECT entityName, content FROM observations${observationWhere} ORDER BY rowid`)
      .all(...list) as { entityName: string; content: string }[];

    const observationsByEntity = new Map<string, string[]>();
    for (const row of observationRows) {
      const observations = observationsByEntity.get(row.entityName) ?? [];
      observations.push(row.content);
      observationsByEntity.set(row.entityName, observations);
    }

    return entityRows.map((row) => ({
      name: row.name,
      entityType: row.entityType,
      observations: observationsByEntity.get(row.name) ?? [],
    }));
  }

  private loadRelations(names?: string[]): Relation[] {
    const list = names ?? [];
    if (names !== undefined && list.length === 0) return [];
    const whereClause =
      list.length > 0
        ? ` WHERE "from" IN (${list.map(() => "?").join(",")}) OR "to" IN (${list.map(() => "?").join(",")})`
        : "";
    const params = list.length > 0 ? [...list, ...list] : [];
    const rows = this.db
      .prepare(`SELECT "from", "to", relationType FROM relations${whereClause} ORDER BY rowid`)
      .all(...params);
    return rows.map((row) => ({
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

  async createEntities(entities: Entity[], provenance?: Provenance): Promise<Entity[]> {
    const insertEntity = this.db.prepare(
      "INSERT OR IGNORE INTO entities (name, entityType, created_at, updated_at, source, session) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertObservation = this.db.prepare(
      "INSERT OR IGNORE INTO observations (entityName, content, created_at, updated_at, source, session) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const source = provenance?.source ?? null;
    const session = provenance?.session ?? null;
    return this.transaction(() => {
      const newEntities: Entity[] = [];
      for (const entity of entities) {
        const now = this.now();
        if (insertEntity.run(entity.name, entity.entityType, now, now, source, session).changes > 0) {
          for (const observation of entity.observations) {
            insertObservation.run(entity.name, observation, now, now, source, session);
          }
          newEntities.push(entity);
        }
      }
      return newEntities;
    });
  }

  async createRelations(relations: Relation[], provenance?: Provenance): Promise<Relation[]> {
    const insertRelation = this.db.prepare(
      'INSERT OR IGNORE INTO relations ("from", "to", relationType, created_at, updated_at, source, session) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const source = provenance?.source ?? null;
    const session = provenance?.session ?? null;
    return this.transaction(() => {
      const newRelations: Relation[] = [];
      for (const relation of relations) {
        const now = this.now();
        if (
          insertRelation.run(
            relation.from,
            relation.to,
            relation.relationType,
            now,
            now,
            source,
            session,
          ).changes > 0
        ) {
          newRelations.push(relation);
        }
      }
      return newRelations;
    });
  }

  async addObservations(
    observations: { entityName: string; contents: string[] }[],
    provenance?: Provenance,
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const findEntity = this.db.prepare("SELECT name FROM entities WHERE name = ?");
    const insertObservation = this.db.prepare(
      "INSERT OR IGNORE INTO observations (entityName, content, created_at, updated_at, source, session) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const source = provenance?.source ?? null;
    const session = provenance?.session ?? null;
    return this.transaction(() => {
      const results = observations.map((o) => {
        if (!findEntity.get(o.entityName)) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }
        const now = this.now();
        const addedObservations: string[] = [];
        for (const content of o.contents) {
          if (insertObservation.run(o.entityName, content, now, now, source, session).changes > 0) {
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
    const deleteEntity = this.db.prepare("DELETE FROM entities WHERE name = ?");
    this.transaction(() => {
      for (const name of entityNames) {
        deleteRelations.run(name, name);
        deleteEntity.run(name); // observations are removed by ON DELETE CASCADE
      }
    });
  }

  async deleteObservations(
    deletions: { entityName: string; observations: string[] }[],
  ): Promise<void> {
    const deleteObservation = this.db.prepare(
      "DELETE FROM observations WHERE entityName = ? AND content = ?",
    );
    this.transaction(() => {
      for (const deletion of deletions) {
        for (const observation of deletion.observations) {
          deleteObservation.run(deletion.entityName, observation);
        }
      }
    });
  }

  async deleteRelations(relations: Relation[]): Promise<void> {
    const deleteRelation = this.db.prepare(
      'DELETE FROM relations WHERE "from" = ? AND "to" = ? AND relationType = ?',
    );
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
        rows = this.db
          .prepare(`
          SELECT DISTINCT e.name
          FROM entities e
          JOIN search_index ON search_index.name = e.name
          WHERE search_index MATCH ?
          ORDER BY e.rowid
        `)
          .all(phrase) as { name: string }[];
      } catch (error) {
        console.error(`FTS search failed for query "${query}", falling back to LIKE scan:`, error);
        rows = this.searchNodesLike(query);
      }
    } else {
      rows = this.searchNodesLike(query);
    }
    return this.graphForEntityNames(rows.map((row) => row.name));
  }

  // LIKE scan fallback (the original search implementation), used for queries
  // the trigram tokenizer cannot handle. Note that FTS5 phrase queries are
  // literal, so on the indexed path `%` and `_` in a query no longer act as
  // wildcards as they did in the LIKE scan.
  private searchNodesLike(query: string): { name: string }[] {
    const pattern = `%${query.toLowerCase()}%`;
    return this.db
      .prepare(`
      SELECT DISTINCT e.name
      FROM entities e
      LEFT JOIN observations o ON o.entityName = e.name
      WHERE LOWER(e.name) LIKE ? OR LOWER(e.entityType) LIKE ? OR LOWER(o.content) LIKE ?
      ORDER BY e.rowid
    `)
      .all(pattern, pattern, pattern) as { name: string }[];
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
  observations: z
    .array(z.string())
    .describe("An array of observation contents associated with the entity"),
});

const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
});

// The server instance and tools exposed to MCP clients
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

// Capture provenance from the MCP layer: the client identity reported during
// the initialize handshake, and the transport session id (undefined over the
// stdio transport, which has a single session per process).
function provenanceFrom(extra: { sessionId?: string }): Provenance {
  return {
    source: server.server.getClientVersion()?.name,
    session: extra.sessionId,
  };
}

// Register create_entities tool
server.registerTool(
  "create_entities",
  {
    title: "Create Entities",
    description: "Create multiple new entities in the knowledge graph",
    inputSchema: {
      entities: z.array(EntitySchema),
    },
    outputSchema: {
      entities: z.array(EntitySchema),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ entities }, extra) => {
    const result = await knowledgeGraphManager.createEntities(entities, provenanceFrom(extra));
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { entities: result },
    };
  },
);

// Register create_relations tool
server.registerTool(
  "create_relations",
  {
    title: "Create Relations",
    description:
      "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
    inputSchema: {
      relations: z.array(RelationSchema),
    },
    outputSchema: {
      relations: z.array(RelationSchema),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ relations }, extra) => {
    const result = await knowledgeGraphManager.createRelations(relations, provenanceFrom(extra));
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { relations: result },
    };
  },
);

// Register add_observations tool
server.registerTool(
  "add_observations",
  {
    title: "Add Observations",
    description: "Add new observations to existing entities in the knowledge graph",
    inputSchema: {
      observations: z.array(
        z.object({
          entityName: z.string().describe("The name of the entity to add the observations to"),
          contents: z.array(z.string()).describe("An array of observation contents to add"),
        }),
      ),
    },
    outputSchema: {
      results: z.array(
        z.object({
          entityName: z.string(),
          addedObservations: z.array(z.string()),
        }),
      ),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ observations }, extra) => {
    const result = await knowledgeGraphManager.addObservations(observations, provenanceFrom(extra));
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      structuredContent: { results: result },
    };
  },
);

// Register delete_entities tool
server.registerTool(
  "delete_entities",
  {
    title: "Delete Entities",
    description: "Delete multiple entities and their associated relations from the knowledge graph",
    inputSchema: {
      entityNames: z.array(z.string()).describe("An array of entity names to delete"),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ entityNames }) => {
    await knowledgeGraphManager.deleteEntities(entityNames);
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: "Entities deleted successfully" }],
      structuredContent: { success: true, message: "Entities deleted successfully" },
    };
  },
);

// Register delete_observations tool
server.registerTool(
  "delete_observations",
  {
    title: "Delete Observations",
    description: "Delete specific observations from entities in the knowledge graph",
    inputSchema: {
      deletions: z.array(
        z.object({
          entityName: z.string().describe("The name of the entity containing the observations"),
          observations: z.array(z.string()).describe("An array of observations to delete"),
        }),
      ),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ deletions }) => {
    await knowledgeGraphManager.deleteObservations(deletions);
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: "Observations deleted successfully" }],
      structuredContent: { success: true, message: "Observations deleted successfully" },
    };
  },
);

// Register delete_relations tool
server.registerTool(
  "delete_relations",
  {
    title: "Delete Relations",
    description: "Delete multiple relations from the knowledge graph",
    inputSchema: {
      relations: z.array(RelationSchema).describe("An array of relations to delete"),
    },
    outputSchema: {
      success: z.boolean(),
      message: z.string(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ relations }) => {
    await knowledgeGraphManager.deleteRelations(relations);
    notifyGraphUpdated();
    return {
      content: [{ type: "text" as const, text: "Relations deleted successfully" }],
      structuredContent: { success: true, message: "Relations deleted successfully" },
    };
  },
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
      relations: z.array(RelationSchema),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const graph = await knowledgeGraphManager.readGraph();
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph },
    };
  },
);

// Register search_nodes tool
server.registerTool(
  "search_nodes",
  {
    title: "Search Nodes",
    description: "Search for nodes in the knowledge graph based on a query",
    inputSchema: {
      query: z
        .string()
        .describe("The search query to match against entity names, types, and observation content"),
    },
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ query }) => {
    const graph = await knowledgeGraphManager.searchNodes(query);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph },
    };
  },
);

// Register open_nodes tool
server.registerTool(
  "open_nodes",
  {
    title: "Open Nodes",
    description: "Open specific nodes in the knowledge graph by their names",
    inputSchema: {
      names: z.array(z.string()).describe("An array of entity names to retrieve"),
    },
    outputSchema: {
      entities: z.array(EntitySchema),
      relations: z.array(RelationSchema),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ names }) => {
    const graph = await knowledgeGraphManager.openNodes(names);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
      structuredContent: { ...graph },
    };
  },
);

export function registerKnowledgeGraphResource(server: McpServer, manager: KnowledgeGraphManager) {
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
  knowledgeGraphManager = await KnowledgeGraphManager.open(MEMORY_FILE_PATH);
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
