import type { SqliteDatabase } from "sqlite-up";

// Enforce case-insensitive entity identity: 'Alice' and 'alice' resolve to one
// entity. Display casing is preserved (first-seen wins); the NOCASE unique
// index only prevents later case-variant duplicates. Note NOCASE folds ASCII
// case only — it does not trim whitespace or fold diacritics.
//
// This does NOT auto-merge pre-existing case collisions — that would require
// lossy choices (which casing and timestamps survive). If collisions exist the
// migration fails with a clear message so they can be merged manually.
export const up = async (db: SqliteDatabase): Promise<void> => {
  const collision = (await db
    .prepare(
      "SELECT name, COUNT(*) AS n FROM entities GROUP BY name COLLATE NOCASE HAVING n > 1 LIMIT 1",
    )
    .get()) as { name: string } | undefined;

  if (collision) {
    throw new Error(
      `entities has case-insensitive name collisions (e.g. "${collision.name}"); merge them manually before upgrading`,
    );
  }

  await db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_nocase ON entities(name COLLATE NOCASE)",
  );
};

export const down = async (db: SqliteDatabase): Promise<void> => {
  await db.exec("DROP INDEX IF EXISTS idx_entities_name_nocase");
};
