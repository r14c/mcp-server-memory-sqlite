import { RELATION_SEMANTICS, inverseOf } from "../ontology.js";
import type { KnowledgeGraph } from "../types.js";
import { render } from "./templates.js";

// The index list only needs identity, not observations or relations.
export interface EntityRef {
  name: string;
  entityType: string;
}

// The relation type is free text, so the inverse hint travels as the datalist
// option's label: picking `part_of` shows that it writes `contains`.
const RELATION_TYPES = Object.keys(RELATION_SEMANTICS).map((type) => {
  const inverse = inverseOf(type);
  return { type, hint: inverse === undefined ? "" : `materializes ${inverse}` };
});

export function indexPanel(entities: EntityRef[]): string {
  return render("index-panel", { entities });
}

export function searchResults(graph: KnowledgeGraph, query: string): string {
  return render("search-panel", { entities: graph.entities, query });
}

// The manager canonicalizes names before writing and matching, so an exact
// comparison is correct here; `entityNames` is the full name list used to
// populate the relation form's datalist.
export function nodePanel(graph: KnowledgeGraph, name: string, entityNames: string[]): string {
  const entity = graph.entities.find((candidate) => candidate.name === name);
  if (entity === undefined) return render("entity-not-found", { name });

  const relations = graph.relations.filter(
    (relation) => relation.from === name || relation.to === name,
  );
  return render("entity-panel", {
    entity,
    entityNames,
    relations,
    relationTypes: RELATION_TYPES,
  });
}

export function errorBanner(message: string): string {
  return render("error-banner", { message });
}

export function notice(message: string): string {
  return render("notice", { message });
}
