import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { KnowledgeGraphManager } from "../lib/manager.js";
import { buildServer } from "../lib/server.js";
import { buildRealisticGraph } from "./guard-fixture.js";

// Regression test for the structured-output validation failure (2026-09-10).
//
// lib/curate.ts trims oversized graph responses and marks the result with a
// `truncated` field. zod emits output schemas with `additionalProperties:
// false`, and the graph tools' outputSchema listed only entities/relations —
// so every curated response was rejected by a conformant client:
//
//   ProtocolError: Structured content does not match the tool's output schema:
//   data must NOT have additional properties
//
// This is the client half of the "search_nodes flaky" story: the server-side
// curation (curate.ts) fixed the pi-mcp-adapter output guard, and the schema
// fix here (lib/server.ts, TruncationInfoSchema) makes the curated payload
// legal again. The repo's own @modelcontextprotocol/sdk does check output
// (server-side validateToolOutput), but it parses with zod, which strips
// unknown keys instead of rejecting them — so an undeclared `truncated` key
// slipped through there while still appearing in the delivered
// structuredContent. This test drives the REAL pi client
// (@modelcontextprotocol/client 2.0.0, the one pi-mcp-adapter uses), which
// validates against the advertised JSON Schema with ajv and rejects the
// undeclared key. That package is not a dependency of this package, so the
// suite skips when it is absent — point PI_MCP_CLIENT_DIR at a checkout to
// run against a different copy.
//
// The client caches tool definitions from tools/list, so listTools() is what
// arms output-schema validation; callTool without it validates nothing.
const PI_CLIENT_DIR =
  process.env.PI_MCP_CLIENT_DIR ??
  path.join(os.homedir(), ".config/pi/agent/npm/node_modules/@modelcontextprotocol/client");
const PI_CLIENT_INDEX = path.join(PI_CLIENT_DIR, "dist/index.mjs");
const available = existsSync(PI_CLIENT_INDEX);

interface PiClientModule {
  Client: new (info: { name: string; version: string }) => {
    connect: (transport: unknown) => Promise<void>;
    listTools: () => Promise<{ tools: { name: string; outputSchema?: unknown }[] }>;
    callTool: (params: {
      name: string;
      arguments: Record<string, unknown>;
    }) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
    close: () => Promise<void>;
  };
  InMemoryTransport: {
    createLinkedPair: () => [unknown, unknown];
  };
}

let pi: PiClientModule;

beforeAll(async () => {
  if (!available) return;
  pi = (await import(pathToFileURL(PI_CLIENT_INDEX).href)) as PiClientModule;
});

describe.skipIf(!available)("pi client structured-output validation (integration)", () => {
  // Curation is opt-in (MEMORY_RESPONSE_MAX_BYTES defaults to 0), and these
  // tests are about the curated payload, so enable it at the adapter's default
  // cap for the duration. The last test covers the default (disabled) contract.
  const BUDGET = 16 * 1024;
  const originalBudget = process.env.MEMORY_RESPONSE_MAX_BYTES;

  beforeEach(() => {
    process.env.MEMORY_RESPONSE_MAX_BYTES = String(BUDGET);
  });

  afterEach(() => {
    if (originalBudget === undefined) delete process.env.MEMORY_RESPONSE_MAX_BYTES;
    else process.env.MEMORY_RESPONSE_MAX_BYTES = originalBudget;
  });

  async function connect(manager: KnowledgeGraphManager) {
    const server = buildServer(manager);
    const client = new pi.Client({ name: "structured-output-test", version: "0.0.1" });
    const [serverTransport, clientTransport] = pi.InMemoryTransport.createLinkedPair();
    // The server is built with @modelcontextprotocol/sdk v1 and the client
    // with v2; the transport interfaces are compatible at runtime.
    await Promise.all([
      (server as unknown as { connect: (t: unknown) => Promise<void> }).connect(serverTransport),
      client.connect(clientTransport),
    ]);
    await client.listTools();
    return client;
  }

  async function openManager() {
    const manager = await KnowledgeGraphManager.open(":memory:");
    await buildRealisticGraph(manager);
    return manager;
  }

  it("accepts a curated read_graph response and reports the truncation", async () => {
    const manager = await openManager();
    const client = await connect(manager);

    const result = await client.callTool({ name: "read_graph", arguments: {} });
    const structured = result.structuredContent as {
      entities: unknown[];
      relations: unknown[];
      truncated: { originalBytes: number; resultBytes: number };
    };

    expect(structured.entities).toHaveLength(6);
    expect(structured.truncated.originalBytes).toBeGreaterThan(structured.truncated.resultBytes);
    await client.close();
  });

  it("accepts curated search_nodes results for a query that matches everything", async () => {
    const manager = await openManager();
    const client = await connect(manager);

    const result = await client.callTool({ name: "search_nodes", arguments: { query: "widget" } });
    const structured = result.structuredContent as {
      entities: unknown[];
      truncated?: unknown;
    };

    expect(structured.entities.length).toBeGreaterThan(0);
    expect(structured.truncated).toBeDefined();
    await client.close();
  });

  it("accepts curated open_nodes results for every entity at once", async () => {
    const manager = await openManager();
    const client = await connect(manager);

    const result = await client.callTool({
      name: "open_nodes",
      arguments: { names: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"] },
    });
    const structured = result.structuredContent as { entities: unknown[]; truncated?: unknown };

    expect(structured.entities.length).toBeGreaterThan(0);
    expect(structured.truncated).toBeDefined();
    await client.close();
  });

  it("accepts small results, which carry no truncated marker", async () => {
    const manager = await KnowledgeGraphManager.open(":memory:");
    await manager.createEntities([{ name: "Zed", entityType: "person", observations: ["tiny"] }]);
    const client = await connect(manager);

    const result = await client.callTool({ name: "search_nodes", arguments: { query: "zed" } });
    const structured = result.structuredContent as {
      entities: unknown[];
      truncated?: unknown;
    };

    expect(structured.entities).toHaveLength(1);
    expect(structured.truncated).toBeUndefined();
    expect(Object.keys(structured)).toEqual(["entities", "relations"]);
    await client.close();
  });

  // The default is no curation: the client receives the whole result, however
  // large, and its own output guard is what bounds it (spilling to a file).
  it("passes the full, uncurated graph through by default", async () => {
    delete process.env.MEMORY_RESPONSE_MAX_BYTES;
    const manager = await openManager();
    const client = await connect(manager);

    const result = await client.callTool({ name: "read_graph", arguments: {} });
    const structured = result.structuredContent as {
      entities: { name: string; observations: string[] }[];
      relations: unknown[];
      truncated?: unknown;
    };

    // Nothing is dropped: every entity with every observation survives.
    expect(structured.entities).toHaveLength(6);
    for (const entity of structured.entities) expect(entity.observations).toHaveLength(8);
    expect(structured.truncated).toBeUndefined();
    expect(Object.keys(structured)).toEqual(["entities", "relations"]);
    expect(Buffer.byteLength(JSON.stringify(structured), "utf8")).toBeGreaterThan(BUDGET);
    await client.close();
  });
});
