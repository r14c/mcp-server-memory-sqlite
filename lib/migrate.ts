import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { Migrator } from "sqlite-up";

// Resolve the migrations directory relative to this compiled module, so the
// same path works when running from source (vitest loads the .ts files) and
// from the compiled dist/ output (node loads the .js files): both layouts keep
// migrations/ as a sibling of lib/.
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

// Apply any migrations not yet recorded in the database. Throws on failure so
// a partially migrated database never starts serving.
export async function applyMigrations(db: DatabaseSync): Promise<void> {
  const migrator = new Migrator({ db, migrationsDir });
  const result = await migrator.apply();
  if (!result.success) {
    const message = result.error?.message ?? "unknown error";
    throw new Error(`Database migration failed: ${message}`);
  }
}
