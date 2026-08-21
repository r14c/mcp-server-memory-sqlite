import type { SqliteDatabase } from "sqlite-up";

// Initial schema: entities, observations, relations, plus the FTS5 trigram
// search index and the triggers that keep it in sync. This replaces the inline
// CREATE TABLE bootstrap previously run on every open.
export const up = async (db: SqliteDatabase): Promise<void> => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      name TEXT PRIMARY KEY,
      entityType TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (
      entityName TEXT NOT NULL REFERENCES entities(name) ON DELETE CASCADE,
      content TEXT NOT NULL,
      PRIMARY KEY (entityName, content)
    );
    CREATE TABLE IF NOT EXISTS relations (
      "from" TEXT NOT NULL,
      "to" TEXT NOT NULL,
      relationType TEXT NOT NULL,
      PRIMARY KEY ("from", "to", relationType)
    );
    -- The observations PK (entityName, content) already covers entityName
    -- lookups and the relations PK ("from", "to", relationType) already
    -- covers "from" lookups, so the standalone indexes on those columns are
    -- redundant write overhead; only the "to" index adds a new lookup path.
    DROP INDEX IF EXISTS idx_observations_entityName;
    DROP INDEX IF EXISTS idx_relations_from;
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations("to");

    -- The search index is fully derived from entities/observations, so it is
    -- dropped and rebuilt rather than migrated in place. This reconciles every
    -- prior schema at once: a database with no index, one with an index that
    -- predates the kind discriminator column, and a current one all converge
    -- on the same table shape, and any orphaned index rows are cleaned up.
    DROP TRIGGER IF EXISTS search_index_entities_ai;
    DROP TRIGGER IF EXISTS search_index_entities_ad;
    DROP TRIGGER IF EXISTS search_index_entities_au;
    DROP TRIGGER IF EXISTS search_index_observations_ai;
    DROP TRIGGER IF EXISTS search_index_observations_ad;
    DROP TRIGGER IF EXISTS search_index_observations_au;
    DROP TABLE IF EXISTS search_index;

    -- FTS5 trigram search index over entity names, entity types, and
    -- observation content. The trigram tokenizer gives literal substring
    -- matching (the old LIKE '%q%' semantics) at index speed. Two kinds of
    -- rows, disambiguated by the unindexed kind column (stored, never
    -- matched): kind='entity' (one row per entity, content '') and
    -- kind='observation' (one row per observation).
    CREATE VIRTUAL TABLE search_index USING fts5(
      name,
      entityType,
      content,
      kind UNINDEXED,
      tokenize = 'trigram'
    );
    CREATE TRIGGER search_index_entities_ai AFTER INSERT ON entities BEGIN
      INSERT INTO search_index (name, entityType, content, kind) VALUES (new.name, new.entityType, '', 'entity');
    END;
    CREATE TRIGGER search_index_entities_ad AFTER DELETE ON entities BEGIN
      DELETE FROM search_index WHERE name = old.name;
    END;
    CREATE TRIGGER search_index_entities_au AFTER UPDATE OF name, entityType ON entities BEGIN
      UPDATE search_index SET name = new.name, entityType = new.entityType WHERE name = old.name AND kind = 'entity';
    END;
    CREATE TRIGGER search_index_observations_ai AFTER INSERT ON observations BEGIN
      INSERT INTO search_index (name, entityType, content, kind) VALUES (new.entityName, '', new.content, 'observation');
    END;
    CREATE TRIGGER search_index_observations_ad AFTER DELETE ON observations BEGIN
      DELETE FROM search_index WHERE name = old.entityName AND content = old.content AND kind = 'observation';
    END;
    CREATE TRIGGER search_index_observations_au AFTER UPDATE OF entityName, content ON observations BEGIN
      UPDATE search_index SET name = new.entityName, content = new.content
      WHERE name = old.entityName AND content = old.content AND kind = 'observation';
    END;

    -- Rebuild the index from the existing rows.
    INSERT INTO search_index (name, entityType, content, kind)
      SELECT e.name, e.entityType, '', 'entity' FROM entities e;
    INSERT INTO search_index (name, entityType, content, kind)
      SELECT o.entityName, '', o.content, 'observation' FROM observations o;
  `);
};

export const down = async (db: SqliteDatabase): Promise<void> => {
  await db.exec(`
    DROP TRIGGER IF EXISTS search_index_entities_ai;
    DROP TRIGGER IF EXISTS search_index_entities_ad;
    DROP TRIGGER IF EXISTS search_index_entities_au;
    DROP TRIGGER IF EXISTS search_index_observations_ai;
    DROP TRIGGER IF EXISTS search_index_observations_ad;
    DROP TRIGGER IF EXISTS search_index_observations_au;
    DROP TABLE IF EXISTS search_index;
    DROP INDEX IF EXISTS idx_relations_to;
    DROP TABLE IF EXISTS relations;
    DROP TABLE IF EXISTS observations;
    DROP TABLE IF EXISTS entities;
  `);
};
