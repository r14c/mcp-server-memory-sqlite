// The class is used as a type only — importing the package root here would
// execute the entry point's module-scope main() (and open the scratch
// database) in every test file that pulls in this fixture.
import type { KnowledgeGraphManager } from "../lib/manager.js";

// pi-mcp-adapter's output-guard defaults (mcp-output-guard.ts):
//   export const DEFAULT_MCP_DETAILS_MAX_BYTES = 16 * 1024;
// detailsMaxBytes caps the raw JSON of a tool result exposed to mcpScript
// consumers; results over the cap are replaced with an { omitted: true }
// summary. This is the client-side behavior behind the "search_nodes flaky"
// issue (see the README note): on a realistic graph, search results are far
// larger than the default cap, so mcpScript callers see "no results".
export const DETAILS_MAX_BYTES = 16 * 1024;

// The documented stopgap: raise the cap globally via mcp.json settings:
//   { "settings": { "outputGuard": { "detailsMaxBytes": 262144 } } }
export const STOPGAP_DETAILS_MAX_BYTES = 256 * 1024;

const OBSERVATION_COUNT = 8;
const OBSERVATION_WORDS = 10;

/** One observation of realistic length (a few hundred chars). */
export function realisticObservation(seed: number, tag = "widget"): string {
  const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit "
    .repeat(OBSERVATION_WORDS)
    .trim();
  return `${tag} note ${seed}: ${filler}`;
}

/**
 * A graph large enough that any search over it produces a tool result bigger
 * than the output-guard default: 6 entities x 8 observations each, all
 * matching the "widget" query (via entityType and observation content).
 */
export async function buildRealisticGraph(manager: KnowledgeGraphManager): Promise<void> {
  const names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
  await manager.createEntities(
    names.map((name, i) => ({
      name,
      entityType: "widget",
      observations: Array.from({ length: OBSERVATION_COUNT }, (_, j) =>
        realisticObservation(i * 10 + j),
      ),
    })),
  );
  // A relation chain so the result carries relations with both endpoints in
  // the matched set (and therefore returned in full).
  await manager.createRelations(
    names.slice(0, -1).map((from, i) => ({ from, to: names[i + 1], relationType: "depends_on" })),
  );
}

/**
 * Serialize a search result exactly the way the server tool does
 * (lib/server.ts search_nodes): pretty-printed text block plus duplicated
 * structuredContent. This is the shape pi-mcp-adapter's output guard measures.
 */
export function serializeSearchResult(graph: { entities: unknown[]; relations: unknown[] }): {
  content: { type: string; text: string }[];
  structuredContent: { entities: unknown[]; relations: unknown[] };
} {
  return {
    content: [{ type: "text", text: JSON.stringify(graph, null, 2) }],
    structuredContent: { ...graph },
  };
}

/**
 * Faithful port of pi-mcp-adapter's boundMcpResult decision (mcp-output-guard.ts):
 * the raw JSON of the tool result is measured; if it exceeds detailsMaxBytes
 * the result is replaced with an { omitted: true } summary that has no
 * entities/relations keys — which is what made search_nodes look "flaky" to
 * mcpScript consumers. Mirrors the real guard so the hermetic suite documents
 * the contract that the (pending) deep-truncation fix must preserve.
 */
export function guardDecision(
  result: unknown,
  detailsMaxBytes = DETAILS_MAX_BYTES,
): { replaced: boolean; rawBytes: number; mcpResult: unknown } {
  const rawBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (rawBytes <= detailsMaxBytes) {
    return { replaced: false, rawBytes, mcpResult: result };
  }
  return {
    replaced: true,
    rawBytes,
    mcpResult: {
      omitted: true,
      reason:
        "Raw MCP result exceeded the details size limit and was replaced with this summary to keep session context bounded.",
      isError: false,
      contentBlocks: 1,
      rawResultBytes: rawBytes,
      fullResultPath: "/tmp/pi-mcp-output-xxxx/mcp-result-xxxx.txt",
    },
  };
}
