import type { SqliteDatabase } from "sqlite-up";

// Rebuild relations with referential integrity: from/to now reference
// entities(name) ON DELETE CASCADE. Dangling edges (endpoints that are not
// entities) are dropped, and case-variant endpoint names are canonicalized to
// the stored entity name before insert so the BINARY foreign key matches.
export const up = async (db: SqliteDatabase): Promise<void> => {
  await db.exec(`
    CREATE TABLE relations_new (
      "from" TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE,
      "to" TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE,
      relationType TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      source TEXT,
      session TEXT,
      PRIMARY KEY ("from", "to", relationType)
    );
    INSERT OR IGNORE INTO relations_new ("from", "to", relationType, created_at, updated_at, source, session)
    SELECT
      (SELECT name FROM entities WHERE name = relations."from" COLLATE NOCASE),
      (SELECT name FROM entities WHERE name = relations."to" COLLATE NOCASE),
      relationType, created_at, updated_at, source, session
    FROM relations
    WHERE (SELECT name FROM entities WHERE name = relations."from" COLLATE NOCASE) IS NOT NULL
      AND (SELECT name FROM entities WHERE name = relations."to" COLLATE NOCASE) IS NOT NULL;
    DROP TABLE relations;
    ALTER TABLE relations_new RENAME TO relations;
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations("to");
  `);
};

export const down = async (db: SqliteDatabase): Promise<void> => {
  await db.exec(`
    CREATE TABLE relations_old (
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      relationType TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      source TEXT,
      session TEXT,
      PRIMARY KEY ("from", "to", relationType)
    );
    INSERT INTO relations_old SELECT "from", "to", relationType, created_at, updated_at, source, session FROM relations;
    DROP TABLE relations;
    ALTER TABLE relations_old RENAME TO relations;
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations("to");
  `);
};
