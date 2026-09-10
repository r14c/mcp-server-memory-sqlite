// We store memory as a knowledge graph: entities (nodes), observations
// (facts about entities), and relations (directed edges between entities).

export interface Entity {
  name: string;
  entityType: string;
  observations: string[];
}

export interface Relation {
  from: string;
  to: string;
  relationType: string;
}

// Provenance captured from the MCP layer and stamped onto written rows: the
// client identity reported during the initialize handshake, and the transport
// session id (undefined over the stdio transport).
export interface Provenance {
  source?: string;
  session?: string;
}

export interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
  // Far endpoints of `relations` that are not themselves in `entities`, so one
  // read returns both the edges and the nodes they point at (a board and its
  // cards, say) instead of forcing a second lookup per endpoint. Deduped, in
  // rowid order. Empty when the result set is closed: `read_graph` loads every
  // entity, so no endpoint can be missing, and a query whose relations all
  // point inside the matched set has no frontier either.
  neighbors: Entity[];
}

// What a delete actually removed. Deletes stay idempotent (a target that is
// already gone is not an error) but no longer report a blanket success, so the
// caller can tell a typo from a completed edit.
export interface DeleteEntitiesResult {
  entityName: string;
}

export interface DeleteObservationsResult {
  entityName: string;
  deletedObservations: string[];
}

export interface UpdateObservationsResult {
  entityName: string;
  updatedObservations: string[];
}
