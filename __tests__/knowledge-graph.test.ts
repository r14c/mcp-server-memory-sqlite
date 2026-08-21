import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "fs";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";
import { KnowledgeGraphManager, Entity, Relation, KnowledgeGraph } from "../index.js";

describe("KnowledgeGraphManager", () => {
  let manager: KnowledgeGraphManager;
  let testFilePath: string;

  beforeEach(async () => {
    // Create a temporary test database path
    testFilePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      `test-memory-${Date.now()}.db`,
    );
    manager = new KnowledgeGraphManager(testFilePath);
  });

  afterEach(async () => {
    // Close the database and clean up the test file
    try {
      manager.close();
    } catch (error) {
      // Ignore errors if the manager was not created
    }
    try {
      await fs.unlink(testFilePath);
    } catch (error) {
      // Ignore errors if file doesn't exist
    }
  });

  describe("createEntities", () => {
    it("should create new entities", async () => {
      const entities: Entity[] = [
        { name: "Alice", entityType: "person", observations: ["works at Acme Corp"] },
        { name: "Bob", entityType: "person", observations: ["likes programming"] },
      ];

      const newEntities = await manager.createEntities(entities);
      expect(newEntities).toHaveLength(2);
      expect(newEntities).toEqual(entities);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(2);
    });

    it("should not create duplicate entities", async () => {
      const entities: Entity[] = [
        { name: "Alice", entityType: "person", observations: ["works at Acme Corp"] },
      ];

      await manager.createEntities(entities);
      const newEntities = await manager.createEntities(entities);

      expect(newEntities).toHaveLength(0);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(1);
    });

    it("should handle empty entity arrays", async () => {
      const newEntities = await manager.createEntities([]);
      expect(newEntities).toHaveLength(0);
    });
  });

  describe("createRelations", () => {
    it("should create new relations", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
      ]);

      const relations: Relation[] = [{ from: "Alice", to: "Bob", relationType: "knows" }];

      const newRelations = await manager.createRelations(relations);
      expect(newRelations).toHaveLength(1);
      expect(newRelations).toEqual(relations);

      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(1);
    });

    it("should not create duplicate relations", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
      ]);

      const relations: Relation[] = [{ from: "Alice", to: "Bob", relationType: "knows" }];

      await manager.createRelations(relations);
      const newRelations = await manager.createRelations(relations);

      expect(newRelations).toHaveLength(0);

      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(1);
    });

    it("should handle empty relation arrays", async () => {
      const newRelations = await manager.createRelations([]);
      expect(newRelations).toHaveLength(0);
    });
  });

  describe("addObservations", () => {
    it("should add observations to existing entities", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: ["works at Acme Corp"] },
      ]);

      const results = await manager.addObservations([
        { entityName: "Alice", contents: ["likes coffee", "has a dog"] },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].entityName).toBe("Alice");
      expect(results[0].addedObservations).toHaveLength(2);

      const graph = await manager.readGraph();
      const alice = graph.entities.find((e) => e.name === "Alice");
      expect(alice?.observations).toHaveLength(3);
    });

    it("should not add duplicate observations", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: ["works at Acme Corp"] },
      ]);

      await manager.addObservations([{ entityName: "Alice", contents: ["likes coffee"] }]);

      const results = await manager.addObservations([
        { entityName: "Alice", contents: ["likes coffee", "has a dog"] },
      ]);

      expect(results[0].addedObservations).toHaveLength(1);
      expect(results[0].addedObservations).toContain("has a dog");

      const graph = await manager.readGraph();
      const alice = graph.entities.find((e) => e.name === "Alice");
      expect(alice?.observations).toHaveLength(3);
    });

    it("should throw error for non-existent entity", async () => {
      await expect(
        manager.addObservations([{ entityName: "NonExistent", contents: ["some observation"] }]),
      ).rejects.toThrow("Entity with name NonExistent not found");
    });
  });

  describe("deleteEntities", () => {
    it("should delete entities", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
      ]);

      await manager.deleteEntities(["Alice"]);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(1);
      expect(graph.entities[0].name).toBe("Bob");
    });

    it("should cascade delete relations when deleting entities", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
        { name: "Charlie", entityType: "person", observations: [] },
      ]);

      await manager.createRelations([
        { from: "Alice", to: "Bob", relationType: "knows" },
        { from: "Bob", to: "Charlie", relationType: "knows" },
      ]);

      await manager.deleteEntities(["Bob"]);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(2);
      expect(graph.relations).toHaveLength(0);
    });

    it("should handle deleting non-existent entities", async () => {
      await manager.deleteEntities(["NonExistent"]);
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
    });
  });

  describe("deleteObservations", () => {
    it("should delete observations from entities", async () => {
      await manager.createEntities([
        {
          name: "Alice",
          entityType: "person",
          observations: ["works at Acme Corp", "likes coffee"],
        },
      ]);

      await manager.deleteObservations([{ entityName: "Alice", observations: ["likes coffee"] }]);

      const graph = await manager.readGraph();
      const alice = graph.entities.find((e) => e.name === "Alice");
      expect(alice?.observations).toHaveLength(1);
      expect(alice?.observations).toContain("works at Acme Corp");
    });

    it("should handle deleting from non-existent entities", async () => {
      await manager.deleteObservations([
        { entityName: "NonExistent", observations: ["some observation"] },
      ]);
      // Should not throw error
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
    });
  });

  describe("deleteRelations", () => {
    it("should delete specific relations", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
      ]);

      await manager.createRelations([
        { from: "Alice", to: "Bob", relationType: "knows" },
        { from: "Alice", to: "Bob", relationType: "works_with" },
      ]);

      await manager.deleteRelations([{ from: "Alice", to: "Bob", relationType: "knows" }]);

      const graph = await manager.readGraph();
      expect(graph.relations).toHaveLength(1);
      expect(graph.relations[0].relationType).toBe("works_with");
    });
  });

  describe("readGraph", () => {
    it("should return empty graph when file does not exist", async () => {
      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(0);
      expect(graph.relations).toHaveLength(0);
    });

    it("should return complete graph with entities and relations", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: ["works at Acme Corp"] },
      ]);

      await manager.createRelations([{ from: "Alice", to: "Alice", relationType: "self" }]);

      const graph = await manager.readGraph();
      expect(graph.entities).toHaveLength(1);
      expect(graph.relations).toHaveLength(1);
    });
  });

  describe("searchNodes", () => {
    beforeEach(async () => {
      await manager.createEntities([
        {
          name: "Alice",
          entityType: "person",
          observations: ["works at Acme Corp", "likes programming"],
        },
        { name: "Bob", entityType: "person", observations: ["works at TechCo"] },
        { name: "Acme Corp", entityType: "company", observations: ["tech company"] },
      ]);

      await manager.createRelations([
        { from: "Alice", to: "Acme Corp", relationType: "works_at" },
        { from: "Bob", to: "Acme Corp", relationType: "competitor" },
      ]);
    });

    it("should search by entity name", async () => {
      const result = await manager.searchNodes("Alice");
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe("Alice");
    });

    it("should search by entity type", async () => {
      const result = await manager.searchNodes("company");
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe("Acme Corp");
    });

    it("should search by observation content", async () => {
      const result = await manager.searchNodes("programming");
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe("Alice");
    });

    it("should be case insensitive", async () => {
      const result = await manager.searchNodes("ALICE");
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe("Alice");
    });

    it("should include relations where at least one endpoint matches", async () => {
      const result = await manager.searchNodes("Acme");
      expect(result.entities).toHaveLength(2); // Alice and Acme Corp
      // Both relations included: Alice → Acme Corp (Alice matched) and Bob → Acme Corp (Acme Corp matched)
      expect(result.relations).toHaveLength(2);
    });

    it("should include outgoing relations to unmatched entities", async () => {
      const result = await manager.searchNodes("Alice");
      expect(result.entities).toHaveLength(1);
      // Alice → Acme Corp relation included because Alice is the source
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe("Alice");
      expect(result.relations[0].to).toBe("Acme Corp");
    });

    it("should return empty graph for no matches", async () => {
      const result = await manager.searchNodes("NonExistent");
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });
  });

  describe("search index", () => {
    it("keeps the FTS index in sync with mutations", async () => {
      await manager.createEntities([
        { name: "Delta", entityType: "person", observations: ["flies delta airlines"] },
      ]);
      expect((await manager.searchNodes("delta")).entities.map((e) => e.name)).toEqual(["Delta"]);

      // New observation on an existing entity becomes searchable
      await manager.addObservations([{ entityName: "Delta", contents: ["likes sqlite"] }]);
      expect((await manager.searchNodes("sqlite")).entities.map((e) => e.name)).toEqual(["Delta"]);

      // Deleted observation stops matching
      await manager.deleteObservations([{ entityName: "Delta", observations: ["likes sqlite"] }]);
      expect((await manager.searchNodes("sqlite")).entities).toHaveLength(0);

      // Deleted entity (cascading its observations) stops matching
      await manager.deleteEntities(["Delta"]);
      expect((await manager.searchNodes("Delta")).entities).toHaveLength(0);
    });

    it("matches entity types and names that only appear in the index, not the data", async () => {
      await manager.createEntities([{ name: "Echo", entityType: "server", observations: [] }]);
      // entityType match via the entity row (content '')
      expect((await manager.searchNodes("serv")).entities.map((e) => e.name)).toEqual(["Echo"]);
    });

    it("does not duplicate search index rows on reopen (one-time backfill)", async () => {
      await manager.createEntities([
        { name: "Foxtrot", entityType: "person", observations: ["first", "second"] },
      ]);

      // Reopen the same database: backfill must not run again
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const db = new DatabaseSync(testFilePath, { readOnly: true });
      // 1 entity row (content '') + 2 observation rows
      expect(db.prepare("SELECT count(*) c FROM search_index").get().c).toBe(3);
      db.close();

      expect((await manager2.searchNodes("second")).entities.map((e) => e.name)).toEqual([
        "Foxtrot",
      ]);
      manager2.close();
    });

    it("populates the search index from a legacy JSONL import", async () => {
      const base = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        `test-legacy-search-${Date.now()}`,
      );
      const jsonlPath = `${base}.jsonl`;
      const dbPath = `${base}.db`;

      await fs.writeFile(
        jsonlPath,
        [
          JSON.stringify({
            type: "entity",
            name: "Golf",
            entityType: "person",
            observations: ["plays golf"],
          }),
        ].join("\n"),
      );

      const importManager = new KnowledgeGraphManager(dbPath);
      const result = await importManager.searchNodes("golf");
      expect(result.entities.map((e) => e.name)).toEqual(["Golf"]);

      importManager.close();
      await fs.unlink(dbPath);
      await fs.unlink(jsonlPath);
    });

    it("uses the FTS index fast path (no LIKE fallback on normal queries)", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: ["works at Acme Corp"] },
      ]);
      // The LIKE fallback logs an error to stderr when the FTS path fails, so
      // a clean search proves the MATCH query actually ran.
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await manager.searchNodes("alice");
        expect(result.entities.map((e) => e.name)).toEqual(["Alice"]);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    it("falls back to LIKE for queries shorter than 3 characters", async () => {
      await manager.createEntities([{ name: "Alice", entityType: "person", observations: [] }]);
      // Two characters is below the trigram minimum, so the LIKE path runs.
      const result = await manager.searchNodes("al");
      expect(result.entities.map((e) => e.name)).toEqual(["Alice"]);
    });

    it("keeps an entity searchable by type when an empty observation is deleted", async () => {
      await manager.createEntities([{ name: "Hotel", entityType: "lodging", observations: [""] }]);
      expect((await manager.searchNodes("lodg")).entities.map((e) => e.name)).toEqual(["Hotel"]);

      await manager.deleteObservations([{ entityName: "Hotel", observations: [""] }]);
      // The entity discriminator row (kind='entity') must survive the
      // observation-row delete; without the kind column this over-deletes.
      expect((await manager.searchNodes("lodg")).entities.map((e) => e.name)).toEqual(["Hotel"]);
      expect((await manager.searchNodes("Hotel")).entities.map((e) => e.name)).toEqual(["Hotel"]);
    });

    it("backfills the search index when opening a pre-search-index database", async () => {
      const oldPath = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        `test-old-schema-${Date.now()}.db`,
      );
      // Build an old-style database: same tables and data, but no search_index
      // and user_version 0 (as produced by the pre-index version of this code).
      const db = new DatabaseSync(oldPath);
      db.exec(`
        CREATE TABLE entities (name TEXT PRIMARY KEY, entityType TEXT NOT NULL);
        CREATE TABLE observations (entityName TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE, content TEXT NOT NULL, PRIMARY KEY (entityName, content));
        CREATE TABLE relations ("from" TEXT NOT NULL, "to" TEXT NOT NULL, relationType TEXT NOT NULL, PRIMARY KEY ("from", "to", relationType));
        INSERT INTO entities VALUES ('Alice','person'),('Acme Corp','company');
        INSERT INTO observations VALUES ('Alice','works at Acme Corp'),('Alice','likes programming'),('Acme Corp','tech company');
        INSERT INTO relations VALUES ('Alice','Acme Corp','works_at');
      `);
      db.close();

      const reopened = new KnowledgeGraphManager(oldPath);
      const result = await reopened.searchNodes("programming");
      expect(result.entities.map((e) => e.name)).toEqual(["Alice"]);
      reopened.close();

      const db2 = new DatabaseSync(oldPath, { readOnly: true });
      expect(db2.prepare("PRAGMA user_version").get().user_version).toBe(1);
      // 2 entity rows + 3 observation rows
      expect(db2.prepare("SELECT count(*) c FROM search_index").get().c).toBe(5);
      db2.close();
      await fs.unlink(oldPath);
      // A read-only connection never owns the WAL, so it leaves the -wal/-shm
      // sidecars behind when it is the last connection to close; clean them up.
      await fs.rm(`${oldPath}-wal`, { force: true });
      await fs.rm(`${oldPath}-shm`, { force: true });
    });
  });

  describe("openNodes", () => {
    beforeEach(async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
        { name: "Charlie", entityType: "person", observations: [] },
      ]);

      await manager.createRelations([
        { from: "Alice", to: "Bob", relationType: "knows" },
        { from: "Bob", to: "Charlie", relationType: "knows" },
      ]);
    });

    it("should open specific nodes by name", async () => {
      const result = await manager.openNodes(["Alice", "Bob"]);
      expect(result.entities).toHaveLength(2);
      expect(result.entities.map((e) => e.name)).toContain("Alice");
      expect(result.entities.map((e) => e.name)).toContain("Bob");
    });

    it("should include all relations connected to opened nodes", async () => {
      const result = await manager.openNodes(["Alice", "Bob"]);
      // Alice → Bob (both endpoints opened) and Bob → Charlie (Bob is opened)
      expect(result.relations).toHaveLength(2);
      expect(result.relations.some((r) => r.from === "Alice" && r.to === "Bob")).toBe(true);
      expect(result.relations.some((r) => r.from === "Bob" && r.to === "Charlie")).toBe(true);
    });

    it("should include relations connected to opened nodes", async () => {
      const result = await manager.openNodes(["Bob"]);
      // Bob has two relations: Alice → Bob and Bob → Charlie
      expect(result.relations).toHaveLength(2);
      expect(result.relations.some((r) => r.from === "Alice" && r.to === "Bob")).toBe(true);
      expect(result.relations.some((r) => r.from === "Bob" && r.to === "Charlie")).toBe(true);
    });

    it("should include outgoing relations to nodes not in the open set", async () => {
      // This is the core bug fix for #3137: open_nodes should return
      // relations FROM the opened node, even if the target is not opened
      const result = await manager.openNodes(["Alice"]);
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0].name).toBe("Alice");
      // Alice → Bob relation is included because Alice is opened
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe("Alice");
      expect(result.relations[0].to).toBe("Bob");
    });

    it("should include incoming relations from nodes not in the open set", async () => {
      const result = await manager.openNodes(["Charlie"]);
      expect(result.entities).toHaveLength(1);
      // Bob → Charlie relation is included because Charlie is opened
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0].from).toBe("Bob");
      expect(result.relations[0].to).toBe("Charlie");
    });

    it("should handle opening non-existent nodes", async () => {
      const result = await manager.openNodes(["NonExistent"]);
      expect(result.entities).toHaveLength(0);
    });

    it("should handle empty node list", async () => {
      const result = await manager.openNodes([]);
      expect(result.entities).toHaveLength(0);
      expect(result.relations).toHaveLength(0);
    });
  });

  describe("file persistence", () => {
    it("should persist data across manager instances", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: ["persistent data"] },
      ]);

      // Create new manager instance with same file path
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const graph = await manager2.readGraph();

      expect(graph.entities).toHaveLength(1);
      expect(graph.entities[0].name).toBe("Alice");
      manager2.close();
    });

    it("should store data in SQLite tables", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: ["works at Acme Corp"] },
      ]);
      await manager.createRelations([{ from: "Alice", to: "Alice", relationType: "self" }]);

      // Read the database directly
      const db = new DatabaseSync(testFilePath, { readOnly: true });
      const entities = db.prepare("SELECT * FROM entities").all();
      const observations = db.prepare("SELECT * FROM observations").all();
      const relations = db.prepare("SELECT * FROM relations").all();
      db.close();

      expect(entities).toHaveLength(1);
      expect(entities[0]).toMatchObject({ name: "Alice", entityType: "person" });
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ entityName: "Alice", content: "works at Acme Corp" });
      expect(relations).toHaveLength(1);
      expect(relations[0]).toMatchObject({ from: "Alice", to: "Alice", relationType: "self" });
    });

    it("should strip type field from entities when loading from file", async () => {
      // Create entities and relations. The old JSONL format stored a `type`
      // field on disk; SQLite never does, so reloading must not leak it.
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: ["test observation"] },
        { name: "Bob", entityType: "person", observations: [] },
      ]);
      await manager.createRelations([{ from: "Alice", to: "Bob", relationType: "knows" }]);

      // Create new manager instance to force reload from the database
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const graph = await manager2.readGraph();

      // Verify loaded entities don't have type field
      expect(graph.entities).toHaveLength(2);
      graph.entities.forEach((entity) => {
        expect(entity).not.toHaveProperty("type");
        expect(entity).toHaveProperty("name");
        expect(entity).toHaveProperty("entityType");
        expect(entity).toHaveProperty("observations");
      });

      // Verify loaded relations don't have type field
      expect(graph.relations).toHaveLength(1);
      graph.relations.forEach((relation) => {
        expect(relation).not.toHaveProperty("type");
        expect(relation).toHaveProperty("from");
        expect(relation).toHaveProperty("to");
        expect(relation).toHaveProperty("relationType");
      });
      manager2.close();
    });

    it("should strip type field from searchNodes results", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: ["works at Acme"] },
      ]);
      await manager.createRelations([{ from: "Alice", to: "Alice", relationType: "self" }]);

      // Create new manager instance to force reload from file
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const result = await manager2.searchNodes("Alice");

      // Verify search results don't have type field
      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).not.toHaveProperty("type");
      expect(result.entities[0].name).toBe("Alice");

      expect(result.relations).toHaveLength(1);
      expect(result.relations[0]).not.toHaveProperty("type");
      expect(result.relations[0].from).toBe("Alice");
      manager2.close();
    });

    it("should strip type field from openNodes results", async () => {
      await manager.createEntities([
        { name: "Alice", entityType: "person", observations: [] },
        { name: "Bob", entityType: "person", observations: [] },
      ]);
      await manager.createRelations([{ from: "Alice", to: "Bob", relationType: "knows" }]);

      // Create new manager instance to force reload from file
      const manager2 = new KnowledgeGraphManager(testFilePath);
      const result = await manager2.openNodes(["Alice", "Bob"]);

      // Verify open results don't have type field
      expect(result.entities).toHaveLength(2);
      result.entities.forEach((entity) => {
        expect(entity).not.toHaveProperty("type");
      });

      expect(result.relations).toHaveLength(1);
      expect(result.relations[0]).not.toHaveProperty("type");
      manager2.close();
    });
  });

  describe("legacy JSONL migration", () => {
    it("imports entities and relations from an existing JSONL file into a new database", async () => {
      const base = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        `test-legacy-${Date.now()}`,
      );
      const jsonlPath = `${base}.jsonl`;
      const dbPath = `${base}.db`;

      await fs.writeFile(
        jsonlPath,
        [
          JSON.stringify({
            type: "entity",
            name: "Alice",
            entityType: "person",
            observations: ["works at Acme Corp"],
          }),
          JSON.stringify({
            type: "entity",
            name: "Acme Corp",
            entityType: "company",
            observations: [],
          }),
          JSON.stringify({
            type: "relation",
            from: "Alice",
            to: "Acme Corp",
            relationType: "works_at",
          }),
        ].join("\n"),
      );

      const migrationManager = new KnowledgeGraphManager(dbPath);
      const graph = await migrationManager.readGraph();

      expect(graph.entities).toHaveLength(2);
      expect(graph.entities[0].name).toBe("Alice");
      expect(graph.entities[0].observations).toEqual(["works at Acme Corp"]);
      expect(graph.relations).toHaveLength(1);
      expect(graph.relations[0]).toEqual({
        from: "Alice",
        to: "Acme Corp",
        relationType: "works_at",
      });

      // Legacy file is left in place as a backup
      expect(await fs.readFile(jsonlPath, "utf-8")).toContain('"type":"entity"');

      migrationManager.close();
      await fs.unlink(dbPath);
      await fs.unlink(jsonlPath);
    });

    it("migrates legacy memory.json files", async () => {
      const base = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        `test-legacy-json-${Date.now()}`,
      );
      const jsonPath = `${base}.json`;
      const dbPath = `${base}.db`;

      await fs.writeFile(
        jsonPath,
        [
          JSON.stringify({ type: "entity", name: "Bob", entityType: "person", observations: [] }),
        ].join("\n"),
      );

      const migrationManager = new KnowledgeGraphManager(dbPath);
      const graph = await migrationManager.readGraph();
      expect(graph.entities).toHaveLength(1);
      expect(graph.entities[0].name).toBe("Bob");

      migrationManager.close();
      await fs.unlink(dbPath);
      await fs.unlink(jsonPath);
    });

    it("does not re-import when the database already exists", async () => {
      const base = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        `test-legacy-existing-${Date.now()}`,
      );
      const jsonlPath = `${base}.jsonl`;
      const dbPath = `${base}.db`;

      // Pre-populate the database
      const preManager = new KnowledgeGraphManager(dbPath);
      await preManager.createEntities([
        { name: "Existing", entityType: "person", observations: ["from db"] },
      ]);
      preManager.close();

      // Legacy file with different content
      await fs.writeFile(
        jsonlPath,
        [
          JSON.stringify({
            type: "entity",
            name: "Legacy",
            entityType: "person",
            observations: [],
          }),
        ].join("\n"),
      );

      // Reopen: migration must not run because the database already exists
      const reopenManager = new KnowledgeGraphManager(dbPath);
      const graph = await reopenManager.readGraph();
      expect(graph.entities).toHaveLength(1);
      expect(graph.entities[0].name).toBe("Existing");

      reopenManager.close();
      await fs.unlink(dbPath);
      await fs.unlink(jsonlPath);
    });

    it("ignores an empty legacy JSONL file", async () => {
      const base = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        `test-legacy-empty-${Date.now()}`,
      );
      const jsonlPath = `${base}.jsonl`;
      const dbPath = `${base}.db`;

      await fs.writeFile(jsonlPath, "\n\n");

      const migrationManager = new KnowledgeGraphManager(dbPath);
      const graph = await migrationManager.readGraph();
      expect(graph.entities).toHaveLength(0);

      migrationManager.close();
      await fs.unlink(dbPath);
      await fs.unlink(jsonlPath);
    });
  });
});
