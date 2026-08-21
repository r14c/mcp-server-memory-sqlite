export interface RelationSemantics {
  inverseOf?: string;
  transitive?: boolean;
}

// Built-in relation vocabulary. inverseOf pairs are materialized automatically
// on write so the graph stays directionally closed: writing A -part_of-> B also
// writes B -contains-> A. transitive is stored as metadata for a future
// traversal consumer and is not materialized.
export const RELATION_SEMANTICS: Record<string, RelationSemantics> = {
  part_of: { inverseOf: "contains" },
  contains: { inverseOf: "part_of" },
  parent_of: { inverseOf: "child_of" },
  child_of: { inverseOf: "parent_of" },
  member_of: { inverseOf: "has_member" },
  has_member: { inverseOf: "member_of" },
  is_a: { transitive: true },
  instance_of: { transitive: true },
};

// The inverse relation type for a given relation type, if declared.
export function inverseOf(relationType: string): string | undefined {
  return RELATION_SEMANTICS[relationType]?.inverseOf;
}
