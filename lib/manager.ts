import { mkdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrate.js";
import { inverseOf } from "./ontology.js";
import type {
  DeleteEntitiesResult,
  DeleteObservationsResult,
  Entity,
  KnowledgeGraph,
  Provenance,
  Relation,
  UpdateObservationsResult,
} from "./types.js";

// node:sqlite reports constraint failures with an extended result code whose
// low byte is SQLITE_CONSTRAINT (19): 1555 for a declared PRIMARY KEY (the
// observations table) and 2067 for a UNIQUE index. Matching the family rather
// than one code keeps this correct if the constraint is ever re-declared.
const SQLITE_CONSTRAINT = 19;

function isConstraintViolation(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === "number" && (errcode & 0xff) === SQLITE_CONSTRAINT;
}

// The KnowledgeGraphManager contains all operations to interact with the
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
      manager.vacuumIfNeeded();
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

  // Reclaim free pages (left behind by deletes and by migration table rebuilds)
  // once per boot, after migrations and the integrity check have run. VACUUM
  // rewrites the whole database file, so it only pays off when the freelist is
  // non-empty; gating on freelist_count keeps a steady-state boot (nothing
  // deleted, no pending migration) from paying the rewrite cost for nothing.
  // Startup latency is the trade-off, but vacuuming here beats vacuuming on
  // shutdown: a crash between a shutdown VACUUM and process exit could leave
  // the database mid-rewrite, and it would also delay teardown while the
  // client waits. Fail-fast like the rest of open(): a failed VACUUM (e.g.
  // ENOSPC on the temp file) is a disk problem the server cannot recover from.
  private vacuumIfNeeded(): void {
    const { freelist_count } = this.db.prepare("PRAGMA freelist_count").get() as {
      freelist_count: number;
    };
    if (freelist_count > 0) {
      this.db.exec("VACUUM");
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

  // Entity names are compared case-insensitively (see the NOCASE unique index
  // from migration 004). Resolve an input name to the canonical stored casing,
  // or undefined if no such entity exists. Callers store the resolved name so
  // the BINARY foreign keys on relations/observations match exactly.
  private resolveEntityName(name: string): string | undefined {
    const row = this.db
      .prepare("SELECT name FROM entities WHERE name = ? COLLATE NOCASE")
      .get(name) as { name: string } | undefined;
    return row?.name;
  }

  private resolveEntityNames(names: string[]): string[] {
    const resolved = new Set<string>();
    for (const name of names) {
      const canonical = this.resolveEntityName(name);
      if (canonical !== undefined) resolved.add(canonical);
    }
    return [...resolved];
  }

  // Import legacy JSONL data (memory.jsonl / memory.json) into the database.
  // Only called when the database file did not exist yet, so existing SQLite
  // data is never touched. The legacy file is left in place as a backup.
  //
  // Legacy files are imported in two passes (entities first, then relations)
  // because upstream JSONL had no foreign keys: a relation line may precede
  // its endpoint's entity line, and the FK constraint would reject that order.
  // Pass 2 also canonicalizes case-variant endpoints to the stored casing and
  // drops genuinely dangling edges, matching migration 005's rebuild behavior
  // for the same legacy data.
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
      let dropped = 0;
      this.db.exec("BEGIN");
      try {
        // Pass 1: entities and their observations. Observations attach to the
        // canonical stored casing so the BINARY observation FK matches even
        // when the file contains case-variant duplicates of one entity.
        for (const line of lines) {
          const item = JSON.parse(line);
          if (item.type !== "entity") continue;
          const canonical = this.resolveEntityName(item.name) ?? item.name;
          if (insertEntity.run(canonical, item.entityType, now, now).changes > 0) {
            entities++;
          }
          for (const observation of item.observations ?? []) {
            insertObservation.run(canonical, observation, now, now);
          }
        }
        // Pass 2: relations, once every endpoint entity is present. Endpoints
        // are canonicalized to the stored casing; edges whose endpoints never
        // appeared in the file are dropped (legacy JSONL had no FK enforcement,
        // so dangling edges were legal there).
        for (const line of lines) {
          const item = JSON.parse(line);
          if (item.type !== "relation") continue;
          const from = this.resolveEntityName(item.from);
          const to = this.resolveEntityName(item.to);
          if (from === undefined || to === undefined) {
            dropped++;
            continue;
          }
          insertRelation.run(from, to, item.relationType, now, now);
          relations++;
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      console.error(
        `MIGRATED: imported ${entities} entities and ${relations} relations from legacy JSONL file ${legacyPath} into SQLite database ${this.memoryFilePath}` +
          (dropped > 0 ? `; dropped ${dropped} dangling relation${dropped === 1 ? "" : "s"}` : ""),
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
      return { entities: [], relations: [], neighbors: [] };
    }
    const entities = this.loadEntities(names);
    const relations = this.loadRelations(names);
    // Far endpoints of those relations: nodes the caller would otherwise have
    // to ask for by name. Only names missing from the result set count — an
    // endpoint already in `entities` is not a frontier.
    const known = new Set(entities.map((entity) => entity.name));
    const frontier = new Set<string>();
    for (const relation of relations) {
      for (const endpoint of [relation.from, relation.to]) {
        if (!known.has(endpoint)) frontier.add(endpoint);
      }
    }
    return { entities, relations, neighbors: this.loadEntities([...frontier]) };
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
        if (
          insertEntity.run(entity.name, entity.entityType, now, now, source, session).changes > 0
        ) {
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
        // Endpoints must resolve to existing entities; a dangling edge is a
        // correctness error, so reject it loudly rather than store garbage.
        const from = this.resolveEntityName(relation.from);
        const to = this.resolveEntityName(relation.to);
        if (from === undefined) {
          throw new Error(`Entity with name ${relation.from} not found`);
        }
        if (to === undefined) {
          throw new Error(`Entity with name ${relation.to} not found`);
        }
        const now = this.now();
        if (
          insertRelation.run(from, to, relation.relationType, now, now, source, session).changes > 0
        ) {
          newRelations.push({ from, to, relationType: relation.relationType });
        }
        // Materialize the declared inverse so the graph stays directionally
        // closed (writing A -part_of-> B also writes B -contains-> A).
        const inverse = inverseOf(relation.relationType);
        if (inverse !== undefined) {
          insertRelation.run(to, from, inverse, now, now, source, session);
        }
      }
      return newRelations;
    });
  }

  async addObservations(
    observations: { entityName: string; contents: string[] }[],
    provenance?: Provenance,
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const insertObservation = this.db.prepare(
      "INSERT OR IGNORE INTO observations (entityName, content, created_at, updated_at, source, session) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const source = provenance?.source ?? null;
    const session = provenance?.session ?? null;
    return this.transaction(() => {
      return observations.map((o) => {
        const entityName = this.resolveEntityName(o.entityName);
        if (entityName === undefined) {
          throw new Error(`Entity with name ${o.entityName} not found`);
        }
        const now = this.now();
        const addedObservations: string[] = [];
        for (const content of o.contents) {
          if (insertObservation.run(entityName, content, now, now, source, session).changes > 0) {
            addedObservations.push(content);
          }
        }
        return { entityName, addedObservations };
      });
    });
  }

  // Replace an observation's text in place, addressed by its exact content.
  // Upstream has no update verb, so an edit is a delete plus an add: two calls,
  // non-atomic, and unverifiable. This is the missing verb. The row is UPDATEd
  // rather than deleted and re-inserted, so created_at keeps the first-written
  // time and updated_at records the edit; the search index follows through the
  // observations UPDATE trigger. An absent match, an unknown entity, or a
  // replacement that already exists on the entity (content is half the primary
  // key) aborts the whole batch rather than half-applying it.
  async updateObservations(
    updates: { entityName: string; match: string; replacement: string }[],
  ): Promise<UpdateObservationsResult[]> {
    const updateObservation = this.db.prepare(
      "UPDATE observations SET content = ?, updated_at = ? WHERE entityName = ? AND content = ?",
    );
    return this.transaction(() => {
      return updates.map((update) => {
        const entityName = this.resolveEntityName(update.entityName);
        if (entityName === undefined) {
          throw new Error(`Entity with name ${update.entityName} not found`);
        }
        // Replacing text with itself is not an edit: the UPDATE would match,
        // report changes=1, and bump updated_at for content that never changed.
        // It is also the one collision the UPDATE cannot detect, since it
        // targets the row it is replacing.
        if (update.replacement === update.match) {
          throw new Error(
            `Observation on ${entityName} already has that content: ${update.replacement}`,
          );
        }
        let changes: number | bigint;
        try {
          changes = updateObservation.run(
            update.replacement,
            this.now(),
            entityName,
            update.match,
          ).changes;
        } catch (error) {
          // A constraint violation here can only be the replacement colliding
          // with an existing observation: content is half the primary key, and
          // that is the table's only constraint. Anything else (busy, ENOSPC, a
          // future schema problem) keeps its own error instead of being
          // relabeled as a collision.
          if (!isConstraintViolation(error)) throw error;
          throw new Error(`Observation already exists on ${entityName}: ${update.replacement}`, {
            cause: error,
          });
        }
        if (changes === 0) {
          throw new Error(`Observation not found on ${entityName}: ${update.match}`);
        }
        return { entityName, updatedObservations: [update.replacement] };
      });
    });
  }

  // Deletes stay idempotent (deleting something that is already gone is a
  // no-op, not a failure) but report exactly what matched, so the caller can
  // tell a completed edit from a typo instead of trusting a blanket success.
  async deleteEntities(entityNames: string[]): Promise<DeleteEntitiesResult[]> {
    // RETURNING hands back the stored casing, so one statement both deletes and
    // reports the canonical name; a case-variant request still matches through
    // COLLATE NOCASE. Relations and observations go with it by ON DELETE
    // CASCADE.
    const deleteEntity = this.db.prepare(
      "DELETE FROM entities WHERE name = ? COLLATE NOCASE RETURNING name",
    );
    return this.transaction(() => {
      const deleted: DeleteEntitiesResult[] = [];
      for (const name of entityNames) {
        const row = deleteEntity.get(name) as { name: string } | undefined;
        if (row !== undefined) deleted.push({ entityName: row.name });
      }
      return deleted;
    });
  }

  async deleteObservations(
    deletions: { entityName: string; observations: string[] }[],
  ): Promise<DeleteObservationsResult[]> {
    // The name is resolved before deleting for two reasons: the stored casing is
    // what the result should echo back, and the requested name may not exist at
    // all — an unknown entity still reports which of its observations matched
    // nothing, so the caller's request is echoed verbatim. Content is the other
    // half of the primary key, so the match is exact rather than fuzzy.
    const deleteObservation = this.db.prepare(
      "DELETE FROM observations WHERE entityName = ? AND content = ?",
    );
    return this.transaction(() =>
      deletions.map((deletion) => {
        const entityName = this.resolveEntityName(deletion.entityName) ?? deletion.entityName;
        const deletedObservations: string[] = [];
        for (const observation of deletion.observations) {
          if (deleteObservation.run(entityName, observation).changes > 0) {
            deletedObservations.push(observation);
          }
        }
        return { entityName, deletedObservations };
      }),
    );
  }

  async deleteRelations(relations: Relation[]): Promise<Relation[]> {
    // RETURNING reports the stored endpoints, so the result names what was
    // actually removed instead of echoing the request. COLLATE NOCASE keeps the
    // lookup case-insensitive while the columns stay BINARY for the FK.
    const deleteRelation = this.db.prepare(
      'DELETE FROM relations WHERE "from" = ? COLLATE NOCASE AND "to" = ? COLLATE NOCASE AND relationType = ? RETURNING "from", "to", relationType',
    );
    const deleteByEndpoints = (
      from: string,
      to: string,
      relationType: string,
    ): Relation | undefined => {
      const row = deleteRelation.get(from, to, relationType) as
        | { from: string; to: string; relationType: string }
        | undefined;
      return row === undefined
        ? undefined
        : { from: row.from, to: row.to, relationType: row.relationType };
    };
    return this.transaction(() => {
      const deleted: Relation[] = [];
      for (const relation of relations) {
        const row = deleteByEndpoints(relation.from, relation.to, relation.relationType);
        // Nothing matched, so nothing to report and nothing to unpick: asking
        // to delete an edge the graph does not have must not take its opposite
        // with it.
        if (row === undefined) continue;
        deleted.push(row);
        // Keep the directional closure consistent: deleting one side of an
        // inverse pair deletes the materialized inverse too. The inverse is not
        // reported — it was never asked for and is not a separate edge.
        const inverse = inverseOf(row.relationType);
        if (inverse !== undefined) {
          deleteByEndpoints(row.to, row.from, inverse);
        }
      }
      return deleted;
    });
  }

  async readGraph(): Promise<KnowledgeGraph> {
    // Every entity is loaded, so no relation endpoint can be missing from
    // `entities`: read_graph has no frontier by construction.
    return {
      entities: this.loadEntities(),
      relations: this.loadRelations(),
      neighbors: [],
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
    return this.graphForEntityNames(this.resolveEntityNames(names));
  }
}
