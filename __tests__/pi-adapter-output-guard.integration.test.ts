import { describe, it, expect, beforeAll } from "vitest";
import { promises as fs } from "fs";
import { existsSync } from "fs";
import { mkdtemp } from "fs/promises";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { KnowledgeGraphManager } from "../index.js";
import {
  buildRealisticGraph,
  serializeSearchResult,
  STOPGAP_DETAILS_MAX_BYTES,
} from "./guard-fixture.js";

// Integration test against the REAL pi-mcp-adapter output guard, confirming
// the "search_nodes flaky" diagnosis: an uncurated realistic search result is
// larger than the guard's default detailsMaxBytes, so guardMcpOutput replaces
// details.mcpResult with an { omitted: true } summary that has no
// entities/relations keys (what mcpScript consumers saw as "no results"). The
// raw result is not lost — the summary carries a fullResultPath spill file —
// which is why the server leaves the bound to the client instead of trimming
// in-band. Raising the cap via the documented stopgap also keeps the result
// intact.
//
// The adapter is vendored under the pi agent npm dir (not a dependency of this
// package), so the suite skips when it is absent — point PI_MCP_ADAPTER_DIR
// elsewhere to run against a different checkout. Node's native TS loader
// refuses to type-strip files under node_modules, but the guard module has no
// runtime imports (only `import type` + node builtins), so a temp copy outside
// node_modules imports cleanly.
const ADAPTER_DIR =
  process.env.PI_MCP_ADAPTER_DIR ??
  path.join(os.homedir(), ".config/pi/agent/npm/node_modules/pi-mcp-adapter");
const GUARD_SOURCE = path.join(ADAPTER_DIR, "mcp-output-guard.ts");
const available = existsSync(GUARD_SOURCE);

let guardMcpOutput: (
  content: unknown[],
  options: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
let DEFAULT_MCP_DETAILS_MAX_BYTES: number;

beforeAll(async () => {
  if (!available) return;
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-adapter-guard-"));
  const copy = path.join(dir, "mcp-output-guard.ts");
  await fs.copyFile(GUARD_SOURCE, copy);
  const mod = (await import(pathToFileURL(copy).href)) as {
    guardMcpOutput: typeof guardMcpOutput;
    DEFAULT_MCP_DETAILS_MAX_BYTES: number;
  };
  guardMcpOutput = mod.guardMcpOutput;
  DEFAULT_MCP_DETAILS_MAX_BYTES = mod.DEFAULT_MCP_DETAILS_MAX_BYTES;
});

describe.skipIf(!available)("pi-mcp-adapter output guard (integration)", () => {
  let manager: KnowledgeGraphManager;
  let testFilePath: string;

  beforeEach(async () => {
    testFilePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      `test-memory-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    manager = await KnowledgeGraphManager.open(testFilePath);
    await buildRealisticGraph(manager);
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

  it("replaces raw search results over the default detailsMaxBytes with an omitted summary (no entities/relations)", async () => {
    // What the guard does to an oversized result: the payload is replaced, but
    // it stays recoverable through the spill file.
    const toolResult = serializeSearchResult(await manager.searchNodes("widget"));

    const guarded = await guardMcpOutput(toolResult.content, { rawMcpResult: toolResult });
    const summary = guarded.mcpResult as Record<string, unknown>;

    expect(summary).toBeDefined();
    expect(summary.omitted).toBe(true);
    expect(summary.entities).toBeUndefined();
    expect(summary.relations).toBeUndefined();
    expect(summary.rawResultBytes).toBeGreaterThan(DEFAULT_MCP_DETAILS_MAX_BYTES);
    expect(typeof summary.fullResultPath).toBe("string");
    // The raw tool result is recoverable from the spill file.
    expect((summary.fullResultPath as string).startsWith(os.tmpdir())).toBe(true);
  });

  it("raising detailsMaxBytes (the documented stopgap) keeps entities/relations intact", async () => {
    const toolResult = serializeSearchResult(await manager.searchNodes("widget"));

    const guarded = await guardMcpOutput(toolResult.content, {
      rawMcpResult: toolResult,
      detailsMaxBytes: STOPGAP_DETAILS_MAX_BYTES,
    });
    expect(guarded.mcpResult).toBe(toolResult);
    expect((toolResult.structuredContent as { entities: unknown[] }).entities).toHaveLength(6);
  });

  it("passes small results through unchanged at the default cap", async () => {
    await manager.createEntities([{ name: "Zed", entityType: "person", observations: ["tiny"] }]);
    const toolResult = serializeSearchResult(await manager.searchNodes("zed"));

    const guarded = await guardMcpOutput(toolResult.content, { rawMcpResult: toolResult });
    expect(guarded.mcpResult).toBe(toolResult);
  });
});
