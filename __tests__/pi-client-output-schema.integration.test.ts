import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { KnowledgeGraphManager } from "../lib/manager.js";
import { buildServer } from "../lib/server.js";
import { buildRealisticGraph } from "./guard-fixture.js";

// Regression test for the structured-output validation failure (2026-09-10).
//
// The graph tools advertise a closed outputSchema (zod emits
// `additionalProperties: false`), so a response field that is not declared
// there makes a conformant client reject the whole result:
//
//   ProtocolError: Structured content does not match the tool's output schema:
//   data must NOT have additional properties
//
// The original offender was a `truncated` marker; the same trap awaits every
// field this fork adds on top of upstream, so each one (neighbors, the delete
// counts, the update results) is called through here. The repo's own
// @modelcontextprotocol/sdk does check output (server-side
// validateToolOutput), but it parses with zod, which strips unknown keys
// instead of rejecting them — so an undeclared key slips through there while
// still appearing in the delivered structuredContent. This test drives the
// REAL pi client (@modelcontextprotocol/client 2.0.0, the one
// pi-mcp-adapter uses), which validates against the advertised JSON Schema
// with ajv and rejects the undeclared key. That package is not a dependency of
// this package, so the suite skips when it is absent — point
// PI_MCP_CLIENT_DIR at a checkout to run against a different copy.
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
    callTool: (params: { name: string; arguments: Record<string, unknown> }) => Promise<{
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      content?: unknown;
    }>;
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

  it("accepts the full graph read, with an empty frontier", async () => {
    const manager = await openManager();
    const client = await connect(manager);

    const result = await client.callTool({ name: "read_graph", arguments: {} });
    const structured = result.structuredContent as {
      entities: { observations: string[] }[];
      relations: unknown[];
      neighbors: unknown[];
    };

    // Nothing is dropped: every matched entity keeps every observation.
    expect(structured.entities).toHaveLength(6);
    for (const entity of structured.entities) expect(entity.observations).toHaveLength(8);
    // read_graph loads every entity, so no endpoint can be a frontier node.
    expect(structured.neighbors).toEqual([]);
    expect(Object.keys(structured).sort()).toEqual(["entities", "neighbors", "relations"]);
    await client.close();
  });

  it("accepts neighbors on search_nodes and open_nodes", async () => {
    const manager = await KnowledgeGraphManager.open(":memory:");
    await manager.createEntities([
      { name: "Board", entityType: "project", observations: ["widget board"] },
      { name: "Card", entityType: "card", observations: ["widget card"] },
    ]);
    await manager.createRelations([{ from: "Card", to: "Board", relationType: "part_of" }]);
    const client = await connect(manager);

    const searched = await client.callTool({
      name: "search_nodes",
      arguments: { query: "widget board" },
    });
    const searchStructured = searched.structuredContent as {
      entities: { name: string }[];
      neighbors: { name: string }[];
    };
    expect(searchStructured.entities.map((e) => e.name)).toEqual(["Board"]);
    // Card does not match the query; it is reachable through the edge.
    expect(searchStructured.neighbors.map((e) => e.name)).toEqual(["Card"]);

    const opened = await client.callTool({
      name: "open_nodes",
      arguments: { names: ["Board"] },
    });
    const openStructured = opened.structuredContent as {
      entities: { name: string }[];
      neighbors: { name: string }[];
    };
    expect(openStructured.entities.map((e) => e.name)).toEqual(["Board"]);
    expect(openStructured.neighbors.map((e) => e.name)).toEqual(["Card"]);
    await client.close();
  });

  it("accepts the delete counts", async () => {
    const manager = await KnowledgeGraphManager.open(":memory:");
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: ["likes coffee"] },
    ]);
    const client = await connect(manager);

    const result = await client.callTool({
      name: "delete_observations",
      arguments: {
        deletions: [{ entityName: "Alice", observations: ["likes coffee", "nope"] }],
      },
    });
    const structured = result.structuredContent as {
      success: boolean;
      message: string;
      results: { entityName: string; deletedObservations: string[] }[];
    };

    expect(structured.success).toBe(true);
    expect(structured.message).toBe("Deleted 1 of 2 requested observations");
    expect(structured.results[0].deletedObservations).toEqual(["likes coffee"]);
    await client.close();
  });

  it("accepts the delete counts for entities and relations", async () => {
    const manager = await KnowledgeGraphManager.open(":memory:");
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: [] },
      { name: "Bob", entityType: "person", observations: [] },
    ]);
    await manager.createRelations([{ from: "Alice", to: "Bob", relationType: "knows" }]);
    const client = await connect(manager);

    const relations = await client.callTool({
      name: "delete_relations",
      arguments: { relations: [{ from: "Alice", to: "Bob", relationType: "knows" }] },
    });
    const relationsStructured = relations.structuredContent as {
      message: string;
      deletedRelations: unknown[];
    };
    expect(relationsStructured.message).toBe("Deleted 1 of 1 requested relations");
    expect(relationsStructured.deletedRelations).toEqual([
      { from: "Alice", to: "Bob", relationType: "knows" },
    ]);

    const entities = await client.callTool({
      name: "delete_entities",
      arguments: { entityNames: ["alice", "Ghost"] },
    });
    const entitiesStructured = entities.structuredContent as {
      message: string;
      deletedEntities: unknown[];
    };
    expect(entitiesStructured.message).toBe("Deleted 1 of 2 requested entities");
    expect(entitiesStructured.deletedEntities).toEqual([{ entityName: "Alice" }]);
    await client.close();
  });

  it("accepts update_observations and applies the edit", async () => {
    const manager = await KnowledgeGraphManager.open(":memory:");
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: ["status: TODO"] },
    ]);
    const client = await connect(manager);

    const result = await client.callTool({
      name: "update_observations",
      arguments: {
        updates: [{ entityName: "Alice", match: "status: TODO", replacement: "status: DONE" }],
      },
    });
    const structured = result.structuredContent as {
      results: { entityName: string; updatedObservations: string[] }[];
    };

    expect(structured.results).toEqual([
      { entityName: "Alice", updatedObservations: ["status: DONE"] },
    ]);
    expect((await manager.openNodes(["Alice"])).entities[0].observations).toEqual(["status: DONE"]);
    await client.close();
  });

  it("surfaces an unmatched update as a tool error, not a silent success", async () => {
    const manager = await KnowledgeGraphManager.open(":memory:");
    await manager.createEntities([
      { name: "Alice", entityType: "person", observations: ["status: TODO"] },
    ]);
    const client = await connect(manager);

    const result = await client.callTool({
      name: "update_observations",
      arguments: {
        updates: [{ entityName: "Alice", match: "status: TYPO", replacement: "status: DONE" }],
      },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Observation not found on Alice");
    await client.close();
  });
});
