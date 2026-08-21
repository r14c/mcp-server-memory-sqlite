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
}
