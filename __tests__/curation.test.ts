import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { KnowledgeGraphManager } from "../index.js";
import { buildRealisticGraph, DETAILS_MAX_BYTES, serializeSearchResult } from "./guard-fixture.js";
import {
  CuratedGraph,
  curateGraph,
  serializeToolResult,
  responseMaxBytes,
  DEFAULT_RESPONSE_MAX_BYTES,
} from "../lib/curate.js";

// Curation is opt-in (DEFAULT_RESPONSE_MAX_BYTES is 0), so the behavior tests
// below pin an explicit budget: DETAILS_MAX_BYTES, pi-mcp-adapter's default
// cap. The env tests at the end cover the default (disabled) and the flag.

// Server-side response curation (opt-in): graph responses are deep-truncated
// so the serialized tool result fits within the client output-guard budget
// (pi-mcp-adapter detailsMaxBytes, default 16 KiB), preserving the top-level
// { entities, relations } shape and reporting the cut in a `truncated` field.
// These tests pass a budget explicitly because the default is 0 (disabled).
describe("response curation (server-side deep truncation)", () => {
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

  it("keeps results that already fit unchanged (same reference, no marker)", async () => {
    await manager.createEntities([{ name: "Zed", entityType: "person", observations: ["tiny"] }]);
    const graph = await manager.searchNodes("zed");

    const curated = curateGraph(graph, DETAILS_MAX_BYTES);
    expect(curated).toBe(graph);
    expect((curated as CuratedGraph).truncated).toBeUndefined();
  });

  it("fits a realistic search result under the default cap with entities/relations intact", async () => {
    await buildRealisticGraph(manager);
    const graph = await manager.searchNodes("widget");

    const curated = curateGraph(graph, DETAILS_MAX_BYTES);
    const bytes = Buffer.byteLength(serializeToolResult(curated), "utf8");
    expect(bytes).toBeLessThanOrEqual(DETAILS_MAX_BYTES);
    expect(curated.entities.length).toBeGreaterThan(0);
    expect(curated.entities.length).toBeLessThanOrEqual(graph.entities.length);
    expect(curated.relations.length).toBeLessThanOrEqual(graph.relations.length);

    const info = (curated as CuratedGraph).truncated;
    expect(info).toBeDefined();
    expect(info!.originalBytes).toBeGreaterThan(DETAILS_MAX_BYTES);
    expect(info!.resultBytes).toBeLessThanOrEqual(DETAILS_MAX_BYTES);
    expect(
      info!.entityCountDropped + info!.observationCountDropped + info!.relationCountDropped,
    ).toBeGreaterThan(0);
  });

  it("does not leak internal fields into the delivered result", async () => {
    await buildRealisticGraph(manager);
    const graph = await manager.searchNodes("widget");

    const curated = curateGraph(graph, DETAILS_MAX_BYTES);
    // Top-level keys are exactly the frozen shape plus the truncation marker
    // (no textTruncated/other internals); same for the structuredContent copy.
    expect(Object.keys(curated).sort()).toEqual(["entities", "relations", "truncated"]);
    const parsed = JSON.parse(serializeToolResult(curated));
    expect(Object.keys(parsed.structuredContent).sort()).toEqual([
      "entities",
      "relations",
      "truncated",
    ]);
    expect("textTruncated" in parsed.structuredContent).toBe(false);
  });

  it("fits the whole graph (read_graph-style) under the cap", async () => {
    await buildRealisticGraph(manager);
    const graph = await manager.readGraph();

    const curated = curateGraph(graph, DETAILS_MAX_BYTES);
    expect(Buffer.byteLength(serializeToolResult(curated), "utf8")).toBeLessThanOrEqual(
      DETAILS_MAX_BYTES,
    );
  });

  it("truncation is deterministic and head-preserving", async () => {
    await buildRealisticGraph(manager);
    const graph = await manager.searchNodes("widget");

    const first = curateGraph(graph, DETAILS_MAX_BYTES);
    const second = curateGraph(graph, DETAILS_MAX_BYTES);
    expect(first).toEqual(second);
    // Head preserved: the first matched entity survives with its name intact.
    expect(first.entities[0].name).toBe(graph.entities[0].name);
  });

  it("prefers observations matching the query when observations are capped", async () => {
    await manager.createEntities([
      {
        name: "NeedleEntity",
        entityType: "thing",
        observations: Array.from(
          { length: 10 },
          (_, i) => `unrelated observation number ${i} with padding text to bulk it up`,
        ).concat(["needle insight: the fact the query actually wanted"]),
      },
    ]);
    const graph = await manager.searchNodes("needle");

    // A tight budget forces observation capping (11 observations cannot fit);
    // large enough that the truncated response (marker included) still fits.
    const curated = curateGraph(graph, 1000, "needle");
    const info = (curated as CuratedGraph).truncated;
    expect(info).toBeDefined();
    expect(info!.observationCountDropped).toBeGreaterThan(0);
    const observations = curated.entities[0].observations;
    expect(observations.length).toBeLessThan(11);
    expect(observations.some((o) => o.includes("needle insight"))).toBe(true);
  });

  it("honors the budget for a range of maxBytes values", async () => {
    await buildRealisticGraph(manager);
    const graph = await manager.searchNodes("widget");

    for (const budget of [4096, 8192, 16384, 32768]) {
      const curated = curateGraph(graph, budget);
      expect(Buffer.byteLength(serializeToolResult(curated), "utf8")).toBeLessThanOrEqual(budget);
    }
  });

  it("maxBytes 0 disables curation", async () => {
    await buildRealisticGraph(manager);
    const graph = await manager.searchNodes("widget");

    const curated = curateGraph(graph, 0);
    expect(curated).toBe(graph);
    expect((curated as CuratedGraph).truncated).toBeUndefined();
  });

  it("budgets below the minimum response size deliver the smallest possible result", async () => {
    await buildRealisticGraph(manager);
    const graph = await manager.searchNodes("widget");

    // No trim level can fit under 100 bytes; the fallback still trims to the
    // most aggressive level instead of returning the untouched oversized graph.
    const curated = curateGraph(graph, 100);
    const info = (curated as CuratedGraph).truncated;
    expect(info).toBeDefined();
    expect(curated.entities).toHaveLength(1);
    expect(curated.relations).toHaveLength(0);
    expect(curated.entities[0].observations[0].length).toBeLessThanOrEqual(41); // 40 chars + ellipsis
    expect(Buffer.byteLength(serializeToolResult(curated), "utf8")).toBeLessThan(
      Buffer.byteLength(serializeToolResult(graph), "utf8"),
    );
  });

  it("serializeToolResult mirrors the tool response the client guard measures", async () => {
    await buildRealisticGraph(manager);
    const graph = await manager.searchNodes("widget");

    const toolResult = serializeSearchResult(graph);
    expect(serializeToolResult(graph)).toBe(JSON.stringify(toolResult));
    expect(Buffer.byteLength(serializeToolResult(graph), "utf8")).toBeGreaterThan(
      DETAILS_MAX_BYTES,
    );
  });

  describe("responseMaxBytes env", () => {
    it("disables curation when unset", () => {
      expect(DEFAULT_RESPONSE_MAX_BYTES).toBe(0);
      expect(responseMaxBytes({})).toBe(0);
      expect(responseMaxBytes({ MEMORY_RESPONSE_MAX_BYTES: "" })).toBe(0);
      expect(responseMaxBytes({ MEMORY_RESPONSE_MAX_BYTES: "  " })).toBe(0);
    });
    it("honors a positive integer", () => {
      expect(responseMaxBytes({ MEMORY_RESPONSE_MAX_BYTES: "32768" })).toBe(32768);
    });
    it("treats 0 as disabled", () => {
      expect(responseMaxBytes({ MEMORY_RESPONSE_MAX_BYTES: "0" })).toBe(0);
    });
    it("stays disabled on garbage", () => {
      expect(responseMaxBytes({ MEMORY_RESPONSE_MAX_BYTES: "abc" })).toBe(0);
      expect(responseMaxBytes({ MEMORY_RESPONSE_MAX_BYTES: "-5" })).toBe(0);
      expect(responseMaxBytes({ MEMORY_RESPONSE_MAX_BYTES: "1.5" })).toBe(0);
    });
  });
});
