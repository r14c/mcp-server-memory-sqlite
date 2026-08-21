import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { up as up004 } from "../migrations/004_nocase_entity_identity.js";
import { up as up005 } from "../migrations/005_relation_foreign_keys.js";
import { up as up006 } from "../migrations/006_deferred_relation_foreign_keys.js";

describe("migration 004 (NOCASE identity)", () => {
  it("fails loudly when entities already have case-insensitive name collisions", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE entities (name TEXT PRIMARY KEY, entityType TEXT NOT NULL)");
    db.exec("INSERT INTO entities VALUES ('Alice', 'person'), ('alice', 'person')");

    await expect(up004(db)).rejects.toThrow(/case-insensitive name collisions/);

    db.close();
  });

  it("adds the NOCASE unique index and dedupes case-variants going forward", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE entities (name TEXT PRIMARY KEY, entityType TEXT NOT NULL)");
    db.exec("INSERT INTO entities VALUES ('Alice', 'person'), ('Bob', 'person')");

    await up004(db);

    const index = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_entities_name_nocase'",
      )
      .get();
    expect(index?.name).toBe("idx_entities_name_nocase");

    // The index enforces case-insensitive uniqueness.
    db.exec("INSERT OR IGNORE INTO entities VALUES ('ALICE', 'other')");
    expect(db.prepare("SELECT count(*) c FROM entities").get().c).toBe(2);

    db.close();
  });
});

describe("migration 005 (relation FKs)", () => {
  it("canonicalizes case-variant endpoints and drops dangling edges", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE entities (name TEXT PRIMARY KEY, entityType TEXT NOT NULL);
      CREATE TABLE relations (
        "from" TEXT NOT NULL,
        "to" TEXT NOT NULL,
        relationType TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        source TEXT,
        session TEXT,
        PRIMARY KEY ("from", "to", relationType)
      );
    `);
    db.exec("INSERT INTO entities VALUES ('Alice', 'person'), ('Bob', 'person')");
    db.exec(
      `INSERT INTO relations ("from", "to", relationType) VALUES
        ('alice', 'Bob', 'knows'),
        ('Ghost', 'Alice', 'knows'),
        ('Alice', 'Bob', 'knows')`,
    );

    await up005(db);

    // 'alice'->'Bob' canonicalized to 'Alice'->'Bob'; the dangling 'Ghost' edge
    // dropped; the duplicate 'Alice'->'Bob' deduped.
    const rows = db.prepare('SELECT "from", "to", relationType FROM relations').all();
    expect(rows).toEqual([{ from: "Alice", to: "Bob", relationType: "knows" }]);

    db.close();
  });
});

describe("migration 006 (deferred relation FKs)", () => {
  it("rebuilds relations with DEFERRABLE INITIALLY DEFERRED foreign keys", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE entities (name TEXT PRIMARY KEY, entityType TEXT NOT NULL);
      CREATE TABLE relations (
        "from" TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE,
        "to" TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE,
        relationType TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        source TEXT,
        session TEXT,
        PRIMARY KEY ("from", "to", relationType)
      );
    `);
    db.exec("INSERT INTO entities VALUES ('Alice', 'person'), ('Bob', 'person')");
    db.exec(`INSERT INTO relations ("from", "to", relationType) VALUES ('Alice', 'Bob', 'knows')`);

    await up006(db);

    // Data survives the rebuild.
    expect(db.prepare('SELECT "from", "to", relationType FROM relations').all()).toEqual([
      { from: "Alice", to: "Bob", relationType: "knows" },
    ]);

    // Behaviorally deferred: a relation may precede its endpoint inside one
    // transaction, as long as the endpoint exists by COMMIT.
    db.exec("BEGIN");
    db.prepare('INSERT INTO relations ("from", "to", relationType) VALUES (?, ?, ?)').run(
      "Carol",
      "Dave",
      "knows",
    );
    db.prepare("INSERT INTO entities (name, entityType) VALUES (?, ?)").run("Carol", "person");
    db.prepare("INSERT INTO entities (name, entityType) VALUES (?, ?)").run("Dave", "person");
    db.exec("COMMIT");

    // A genuinely dangling edge still fails at COMMIT.
    db.exec("BEGIN");
    db.prepare('INSERT INTO relations ("from", "to", relationType) VALUES (?, ?, ?)').run(
      "Ghost",
      "Alice",
      "knows",
    );
    expect(() => db.exec("COMMIT")).toThrow(/FOREIGN KEY constraint failed/);
    db.exec("ROLLBACK");

    db.close();
  });
});
