import type { SqliteDatabase } from "sqlite-up";

// Add source/session provenance columns captured from the MCP layer. Both are
// nullable: legacy rows (and the legacy JSONL import) predate provenance, and
// the stdio transport has no session id. New rows are stamped by the
// application on insert.
const TABLES = ["entities", "observations", "relations"] as const;

export const up = async (db: SqliteDatabase): Promise<void> => {
  for (const table of TABLES) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN source TEXT`);
    await db.exec(`ALTER TABLE ${table} ADD COLUMN session TEXT`);
  }
};

export const down = async (db: SqliteDatabase): Promise<void> => {
  for (const table of TABLES) {
    await db.exec(`ALTER TABLE ${table} DROP COLUMN session`);
    await db.exec(`ALTER TABLE ${table} DROP COLUMN source`);
  }
};
