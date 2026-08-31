import type { KnowledgeGraph } from "./types.js";

// Response curation: client output guards (e.g. pi-mcp-adapter) replace any
// tool result whose JSON exceeds a byte budget (detailsMaxBytes, default
// 16 KiB) with an { omitted: true } summary that has no entities/relations
// keys — so large search results looked like "no results". Instead of patching
// the client, this server curates graph responses so the serialized tool
// result fits under the same default budget: deep truncation that preserves
// the top-level { entities, relations } shape and trims the payload in stages
// until it fits. Truncation is deterministic and head-preserving, keeps
// query-matching observations for search_nodes, and reports itself in a
// `truncated` field (only present when data was dropped) so callers know the
// response is lossy. The budget is configurable via MEMORY_RESPONSE_MAX_BYTES
// (0 disables curation); results that already fit pass through unchanged.

export const DEFAULT_RESPONSE_MAX_BYTES = 16 * 1024; // pi-mcp-adapter DEFAULT_MCP_DETAILS_MAX_BYTES

export interface TruncationInfo {
  maxBytes: number;
  originalBytes: number;
  resultBytes: number;
  entityCountDropped: number;
  observationCountDropped: number;
  relationCountDropped: number;
  observationTextTruncated: boolean;
}

export interface CuratedGraph extends KnowledgeGraph {
  truncated?: TruncationInfo;
  // structuredContent is a JSON object; the index signature keeps the
  // interface assignable to the SDK's Record<string, unknown> contract.
  [key: string]: unknown;
}

/** Resolve the response budget from MEMORY_RESPONSE_MAX_BYTES (0 = disabled). */
export function responseMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMORY_RESPONSE_MAX_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RESPONSE_MAX_BYTES;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < 0) return DEFAULT_RESPONSE_MAX_BYTES;
  return n;
}

const ELLIPSIS = "…";

interface TrimLevel {
  maxObservationChars: number;
  maxObservationsPerEntity: number;
  maxRelations: number;
  maxEntities: number;
}

// Cumulative tightening schedule, applied in order until the serialized tool
// result fits the budget. Each level is stricter than the last; the final
// level (one entity, one short observation, no relations) always fits.
const LEVELS: TrimLevel[] = [
  { maxObservationChars: 300, maxObservationsPerEntity: Infinity, maxRelations: Infinity, maxEntities: Infinity },
  { maxObservationChars: 160, maxObservationsPerEntity: Infinity, maxRelations: Infinity, maxEntities: Infinity },
  { maxObservationChars: 160, maxObservationsPerEntity: 4, maxRelations: Infinity, maxEntities: Infinity },
  { maxObservationChars: 80, maxObservationsPerEntity: 4, maxRelations: Infinity, maxEntities: Infinity },
  { maxObservationChars: 80, maxObservationsPerEntity: 2, maxRelations: 20, maxEntities: Infinity },
  { maxObservationChars: 40, maxObservationsPerEntity: 2, maxRelations: 10, maxEntities: 10 },
  { maxObservationChars: 40, maxObservationsPerEntity: 1, maxRelations: 5, maxEntities: 5 },
  { maxObservationChars: 40, maxObservationsPerEntity: 1, maxRelations: 0, maxEntities: 2 },
  { maxObservationChars: 40, maxObservationsPerEntity: 1, maxRelations: 0, maxEntities: 1 },
];

interface TrimmedGraph extends KnowledgeGraph {
  textTruncated: boolean;
}

function applyLevel(graph: KnowledgeGraph, level: TrimLevel, prefer?: string): TrimmedGraph {
  const preferLower = prefer?.toLowerCase();
  let textTruncated = false;
  const entities = graph.entities.slice(0, level.maxEntities).map((entity) => {
    let observations = entity.observations;
    if (Number.isFinite(level.maxObservationsPerEntity)) {
      // Prefer observations matching the query so a curated search response
      // keeps the most relevant facts; otherwise keep the head of the list.
      if (preferLower) {
        const hit: string[] = [];
        const miss: string[] = [];
        for (const observation of observations) {
          (observation.toLowerCase().includes(preferLower) ? hit : miss).push(observation);
        }
        observations = [...hit, ...miss];
      }
      observations = observations.slice(0, level.maxObservationsPerEntity);
    }
    observations = observations.map((observation) => {
      if (observation.length > level.maxObservationChars) {
        textTruncated = true;
        return observation.slice(0, level.maxObservationChars) + ELLIPSIS;
      }
      return observation;
    });
    return { ...entity, observations };
  });
  const relations = graph.relations.slice(0, level.maxRelations);
  // Relations are head-kept and may name entities dropped by entity
  // truncation — consistent with the search contract, which already returns
  // relations to unmatched entities.
  return { entities, relations, textTruncated };
}

function totalObservations(graph: KnowledgeGraph): number {
  return graph.entities.reduce((sum, entity) => sum + entity.observations.length, 0);
}

/**
 * Serialize a tool result exactly as the server returns it (lib/server.ts:
 * pretty-printed text block plus duplicated structuredContent) and as the
 * client output guard measures it.
 */
export function serializeToolResult(graph: KnowledgeGraph): string {
  const response = {
    content: [{ type: "text", text: JSON.stringify(graph, null, 2) }],
    structuredContent: { ...graph },
  };
  return JSON.stringify(response);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

interface BuiltCurated {
  curated: CuratedGraph;
  resultBytes: number;
}

/**
 * Build the final response for one trim level. The `truncated` marker is
 * measured as part of the payload: resultBytes is first set to a placeholder
 * (originalBytes, always >= the final value) and patched after measuring, so
 * patching cannot grow the serialized size past the measured bound. The
 * internal `textTruncated` flag is consumed into the marker, not leaked into
 * the delivered object.
 */
function buildCurated(
  graph: KnowledgeGraph,
  level: TrimLevel,
  prefer: string | undefined,
  maxBytes: number,
  originalBytes: number,
): BuiltCurated {
  const trimmed = applyLevel(graph, level, prefer);
  const truncated: TruncationInfo = {
    maxBytes,
    originalBytes,
    resultBytes: originalBytes,
    entityCountDropped: graph.entities.length - trimmed.entities.length,
    observationCountDropped: totalObservations(graph) - totalObservations(trimmed),
    relationCountDropped: graph.relations.length - trimmed.relations.length,
    observationTextTruncated: trimmed.textTruncated,
  };
  const curated: CuratedGraph = { entities: trimmed.entities, relations: trimmed.relations, truncated };
  const resultBytes = byteLength(serializeToolResult(curated));
  truncated.resultBytes = resultBytes;
  return { curated, resultBytes };
}

/**
 * Deep-truncate a graph response so its serialized tool-result form fits
 * within maxBytes. Returns the original graph unchanged when it already fits
 * (or when maxBytes is 0), and otherwise the first tightening level that fits,
 * annotated with a `truncated` field describing what was dropped. For budgets
 * below the minimum response size (a few hundred bytes) no level fits; the
 * most aggressively trimmed result is delivered anyway rather than the
 * untouched graph.
 */
export function curateGraph(
  graph: KnowledgeGraph,
  maxBytes: number = DEFAULT_RESPONSE_MAX_BYTES,
  prefer?: string,
): CuratedGraph {
  if (maxBytes <= 0) return graph as CuratedGraph;
  const originalBytes = byteLength(serializeToolResult(graph));
  if (originalBytes <= maxBytes) return graph as CuratedGraph;

  for (const level of LEVELS) {
    const { curated, resultBytes } = buildCurated(graph, level, prefer, maxBytes, originalBytes);
    if (resultBytes <= maxBytes) return curated;
  }
  const last = buildCurated(graph, LEVELS[LEVELS.length - 1], prefer, maxBytes, originalBytes);
  return last.curated;
}

/** Build the final tool response from a curated graph (used by all graph tools). */
export function curatedToolResponse(
  graph: KnowledgeGraph,
  maxBytes: number,
  prefer?: string,
): { content: { type: "text"; text: string }[]; structuredContent: CuratedGraph } {
  const curated = curateGraph(graph, maxBytes, prefer);
  return {
    content: [{ type: "text", text: JSON.stringify(curated, null, 2) }],
    structuredContent: { ...curated },
  };
}
