import type { SqliteDatabase } from "sqlite-up";

// Rebuild relations with deferred foreign key enforcement. The from/to FKs
// still reference entities(name) ON DELETE CASCADE, but DEFERRABLE INITIALLY
// DEFERRED moves the check from the end of each INSERT statement to the
// enclosing transaction's COMMIT: a bulk insert may now create a relation
// before its endpoint entity within the same transaction, and order stops
// mattering. A genuinely dangling edge still fails at COMMIT and rolls back
// the whole transaction, so referential integrity is preserved — only the
// ordering requirement is relaxed.
//
// The copy is a straight one because migration 005 already canonicalized
// case-variant endpoints and dropped dangling edges; the data here is clean.
export const up = async (db: SqliteDatabase): Promise<void> => {
  await db.exec(`
    CREATE TABLE relations_new (
      "from" TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      "to" TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      relationType TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      source TEXT,
      session TEXT,
      PRIMARY KEY ("from", "to", relationType)
    );
    INSERT INTO relations_new ("from", "to", relationType, created_at, updated_at, source, session)
    SELECT "from", "to", relationType, created_at, updated_at, source, session FROM relations;
    DROP TABLE relations;
    ALTER TABLE relations_new RENAME TO relations;
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations("to");
  `);
};

export const down = async (db: SqliteDatabase): Promise<void> => {
  await db.exec(`
    CREATE TABLE relations_old (
      "from" TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE,
      "to" TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE,
      relationType TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      source TEXT,
      session TEXT,
      PRIMARY KEY ("from", "to", relationType)
    );
    INSERT INTO relations_old ("from", "to", relationType, created_at, updated_at, source, session)
    SELECT "from", "to", relationType, created_at, updated_at, source, session FROM relations;
    DROP TABLE relations;
    ALTER TABLE relations_old RENAME TO relations;
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations("to");
  `);
};
