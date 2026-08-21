import type { SqliteDatabase } from "sqlite-up";

// Add created_at/updated_at provenance columns to every graph table. New rows
// are stamped by the application on insert; the '' default only exists so the
// ALTER TABLE ADD COLUMN NOT NULL constraint can be satisfied, and every
// pre-existing row is backfilled with the migration time below.
const TABLES = ["entities", "observations", "relations"] as const;

export const up = async (db: SqliteDatabase): Promise<void> => {
  // The true creation time of legacy rows is unknown; the migration time is
  // the best available upper bound.
  const now = new Date().toISOString();

  for (const table of TABLES) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN created_at TEXT NOT NULL DEFAULT ''`);
    await db.exec(`ALTER TABLE ${table} ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`);
    await db
      .prepare(`UPDATE ${table} SET created_at = ?, updated_at = ? WHERE created_at = ''`)
      .run(now, now);
  }
};

export const down = async (db: SqliteDatabase): Promise<void> => {
  for (const table of TABLES) {
    await db.exec(`ALTER TABLE ${table} DROP COLUMN updated_at`);
    await db.exec(`ALTER TABLE ${table} DROP COLUMN created_at`);
  }
};
