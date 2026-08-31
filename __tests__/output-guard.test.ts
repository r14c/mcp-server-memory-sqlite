import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import { DatabaseSync } from "node:sqlite";
import path from "path";
import { fileURLToPath } from "url";
import { KnowledgeGraphManager } from "../index.js";
import {
  DETAILS_MAX_BYTES,
  STOPGAP_DETAILS_MAX_BYTES,
  buildRealisticGraph,
  serializeSearchResult,
  guardDecision,
} from "./guard-fixture.js";

// Regression tests for the "search_nodes flaky" issue (2026-08-30).
//
// Root cause, confirmed by direct SQL probes and live reproduction: the server
// is correct — search_nodes returns the full graph of matches (entities with
// all their observations, plus relations touching them), and on a realistic
// graph that result serializes to far more than pi-mcp-adapter's
// detailsMaxBytes default (16 KiB). On the mcpScript/worker call path the
// adapter's output guard then replaces the result with an { omitted: true }
// summary that has no entities/relations keys, so callers see "no results".
//
// These tests pin the server-side behavior (full graph, large result) and
// document the guard's decision contract — the thing the pending deep
// truncation fix in pi-mcp-adapter must change (keep the top-level
// { entities, relations } shape instead of replacing the whole result).
describe("search result size vs. pi-mcp-adapter output guard", () => {
  let manager: KnowledgeGraphManager;
  let testFilePath: string;

  beforeEach(async () => {
    testFilePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      `test-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    manager = await KnowledgeGraphManager.open(testFilePath);
  });

  afterEach(async () => {
    try {
      manager.close();
    } catch {
      // Manager may not have been created.
    }
    try {
      await fs.unlink(testFilePath);
    } catch {
      // File may not exist.
    }
  });

  it("returns the full match graph on a realistic graph (server is correct)", async () => {
    await buildRealisticGraph(manager);
    const result = await manager.searchNodes("widget");
    expect(result.entities).toHaveLength(6);
    expect(result.entities.map((e) => e.name)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
      "Epsilon",
      "Zeta",
    ]);
    // Every matched entity is returned with all of its observations.
    for (const entity of result.entities) {
      expect(entity.observations).toHaveLength(8);
    }
    expect(result.relations).toHaveLength(5);
  });

  it("serializes the search result (as the tool does) beyond the guard's default detailsMaxBytes", async () => {
    await buildRealisticGraph(manager);
    const result = await manager.searchNodes("widget");
    const toolResult = serializeSearchResult(result);

    const textBytes = Buffer.byteLength(toolResult.content[0].text, "utf8");
    const rawBytes = Buffer.byteLength(JSON.stringify(toolResult), "utf8");
    // The trigger condition of the "flaky" symptom: the tool result is larger
    // than pi-mcp-adapter's DEFAULT_MCP_DETAILS_MAX_BYTES (16 KiB), so the
    // output guard will replace it on the mcpScript/worker path.
    expect(textBytes).toBeGreaterThan(DETAILS_MAX_BYTES);
    expect(rawBytes).toBeGreaterThan(DETAILS_MAX_BYTES);
  });

  it("guard replacement (default cap) drops entities/relations — the reported symptom", async () => {
    await buildRealisticGraph(manager);
    const toolResult = serializeSearchResult(await manager.searchNodes("widget"));

    const { replaced, rawBytes, mcpResult } = guardDecision(toolResult, DETAILS_MAX_BYTES);
    expect(replaced).toBe(true);
    expect(rawBytes).toBeGreaterThan(DETAILS_MAX_BYTES);
    // The replacement summary has no entities/relations keys; mcpScript
    // consumers reading g.data.entities see undefined -> "0 results".
    expect(mcpResult).toMatchObject({ omitted: true, rawResultBytes: rawBytes });
    expect("entities" in (mcpResult as object)).toBe(false);
    expect("relations" in (mcpResult as object)).toBe(false);
  });

  it("raising detailsMaxBytes (the documented stopgap) keeps entities/relations", async () => {
    await buildRealisticGraph(manager);
    const toolResult = serializeSearchResult(await manager.searchNodes("widget"));

    const { replaced, mcpResult } = guardDecision(toolResult, STOPGAP_DETAILS_MAX_BYTES);
    expect(replaced).toBe(false);
    const graph = mcpResult as { structuredContent: { entities: unknown[] } };
    expect(graph.structuredContent.entities).toHaveLength(6);
  });

  it("small results pass through the guard unchanged", async () => {
    await manager.createEntities([
      { name: "Zed", entityType: "person", observations: ["tiny"] },
    ]);
    const toolResult = serializeSearchResult(await manager.searchNodes("zed"));

    const { replaced, mcpResult } = guardDecision(toolResult, DETAILS_MAX_BYTES);
    expect(replaced).toBe(false);
    expect((mcpResult as { structuredContent: { entities: unknown[] } }).structuredContent.entities).toHaveLength(1);
  });
});
