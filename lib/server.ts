import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { KnowledgeGraphManager } from "./manager.js";
import type { Provenance } from "./types.js";
import { curatedToolResponse, responseMaxBytes } from "./curate.js";
import pkg from "../package.json" with { type: "json" };

// Zod schemas for entities and relations.
const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z
    .array(z.string())
    .describe("An array of observation contents associated with the entity"),
});

const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
});

// Mirrors TruncationInfo in lib/curate.ts. The graph tools' outputSchema is
// closed (zod emits `additionalProperties: false`), and curate.ts attaches
// `truncated` to any response it had to trim — so the field must be declared
// here or conformant clients reject the result.
const TruncationInfoSchema = z
  .object({
    maxBytes: z.number().describe("The response budget the result was trimmed to fit"),
    originalBytes: z.number().describe("Serialized size of the untrimmed tool result"),
    resultBytes: z.number().describe("Serialized size of this trimmed tool result"),
    entityCountDropped: z.number(),
    observationCountDropped: z.number(),
    relationCountDropped: z.number(),
    observationTextTruncated: z.boolean(),
  })
  .optional()
  .describe("Present only when the response was trimmed to fit the client's output budget");

export const RESOURCE_URI = "memory://knowledge-graph";

// Track which resource URIs the connected client has subscribed to, so we only
// emit notifications/resources/updated to a client that asked for them.
const resourceSubscribers = new Set<string>();

export function registerKnowledgeGraphResource(server: McpServer, manager: KnowledgeGraphManager) {
  server.registerResource(
    "knowledge-graph",
    RESOURCE_URI,
    {
      title: "Knowledge Graph",
      description: "The full knowledge graph with all entities and relations",
      mimeType: "application/json",
    },
    async (uri) => {
      const graph = await manager.readGraph();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(graph, null, 2),
          },
        ],
      };
    },
  );
}

// Enable clients to subscribe to the knowledge-graph resource and receive
// notifications/resources/updated when mutation tools change the graph.
export function registerKnowledgeGraphSubscriptions(server: McpServer) {
  server.server.registerCapabilities({ resources: { subscribe: true } });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    resourceSubscribers.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    resourceSubscribers.delete(request.params.uri);
    return {};
  });
}

// Build the MCP server: register the nine tools, the knowledge-graph resource,
// and the subscription capability. The tool surface (names, schemas, shapes)
// is frozen to match upstream @modelcontextprotocol/server-memory; only the
// storage layer differs.
export function buildServer(manager: KnowledgeGraphManager): McpServer {
  const server = new McpServer({
    name: "memory-server",
    version: pkg.version,
  });

  // Notify subscribers that the knowledge graph resource changed. No-op when
  // the client has not subscribed.
  const notifyGraphUpdated = () => {
    if (resourceSubscribers.has(RESOURCE_URI)) {
      server.server.sendResourceUpdated({ uri: RESOURCE_URI });
    }
  };

  // Capture provenance from the MCP layer: the client identity reported during
  // the initialize handshake, and the transport session id (undefined over the
  // stdio transport, which has a single session per process).
  const provenanceFrom = (extra: { sessionId?: string }): Provenance => ({
    source: server.server.getClientVersion()?.name,
    session: extra.sessionId,
  });

  // Register create_entities tool
  server.registerTool(
    "create_entities",
    {
      title: "Create Entities",
      description: "Create multiple new entities in the knowledge graph",
      inputSchema: {
        entities: z.array(EntitySchema),
      },
      outputSchema: {
        entities: z.array(EntitySchema),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ entities }, extra) => {
      const result = await manager.createEntities(entities, provenanceFrom(extra));
      notifyGraphUpdated();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: { entities: result },
      };
    },
  );

  // Register create_relations tool
  server.registerTool(
    "create_relations",
    {
      title: "Create Relations",
      description:
        "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
      inputSchema: {
        relations: z.array(RelationSchema),
      },
      outputSchema: {
        relations: z.array(RelationSchema),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ relations }, extra) => {
      const result = await manager.createRelations(relations, provenanceFrom(extra));
      notifyGraphUpdated();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: { relations: result },
      };
    },
  );

  // Register add_observations tool
  server.registerTool(
    "add_observations",
    {
      title: "Add Observations",
      description: "Add new observations to existing entities in the knowledge graph",
      inputSchema: {
        observations: z.array(
          z.object({
            entityName: z.string().describe("The name of the entity to add the observations to"),
            contents: z.array(z.string()).describe("An array of observation contents to add"),
          }),
        ),
      },
      outputSchema: {
        results: z.array(
          z.object({
            entityName: z.string(),
            addedObservations: z.array(z.string()),
          }),
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ observations }, extra) => {
      const result = await manager.addObservations(observations, provenanceFrom(extra));
      notifyGraphUpdated();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: { results: result },
      };
    },
  );

  // Register delete_entities tool
  server.registerTool(
    "delete_entities",
    {
      title: "Delete Entities",
      description:
        "Delete multiple entities and their associated relations from the knowledge graph",
      inputSchema: {
        entityNames: z.array(z.string()).describe("An array of entity names to delete"),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ entityNames }) => {
      await manager.deleteEntities(entityNames);
      notifyGraphUpdated();
      return {
        content: [{ type: "text" as const, text: "Entities deleted successfully" }],
        structuredContent: { success: true, message: "Entities deleted successfully" },
      };
    },
  );

  // Register delete_observations tool
  server.registerTool(
    "delete_observations",
    {
      title: "Delete Observations",
      description: "Delete specific observations from entities in the knowledge graph",
      inputSchema: {
        deletions: z.array(
          z.object({
            entityName: z.string().describe("The name of the entity containing the observations"),
            observations: z.array(z.string()).describe("An array of observations to delete"),
          }),
        ),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deletions }) => {
      await manager.deleteObservations(deletions);
      notifyGraphUpdated();
      return {
        content: [{ type: "text" as const, text: "Observations deleted successfully" }],
        structuredContent: { success: true, message: "Observations deleted successfully" },
      };
    },
  );

  // Register delete_relations tool
  server.registerTool(
    "delete_relations",
    {
      title: "Delete Relations",
      description: "Delete multiple relations from the knowledge graph",
      inputSchema: {
        relations: z.array(RelationSchema).describe("An array of relations to delete"),
      },
      outputSchema: {
        success: z.boolean(),
        message: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ relations }) => {
      await manager.deleteRelations(relations);
      notifyGraphUpdated();
      return {
        content: [{ type: "text" as const, text: "Relations deleted successfully" }],
        structuredContent: { success: true, message: "Relations deleted successfully" },
      };
    },
  );

  // Register read_graph tool
  server.registerTool(
    "read_graph",
    {
      title: "Read Graph",
      description: "Read the entire knowledge graph",
      inputSchema: {},
      outputSchema: {
        entities: z.array(EntitySchema),
        relations: z.array(RelationSchema),
        truncated: TruncationInfoSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const graph = await manager.readGraph();
      return curatedToolResponse(graph, responseMaxBytes());
    },
  );

  // Register search_nodes tool
  server.registerTool(
    "search_nodes",
    {
      title: "Search Nodes",
      description: "Search for nodes in the knowledge graph based on a query",
      inputSchema: {
        query: z
          .string()
          .describe(
            "The search query to match against entity names, types, and observation content",
          ),
      },
      outputSchema: {
        entities: z.array(EntitySchema),
        relations: z.array(RelationSchema),
        truncated: TruncationInfoSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      const graph = await manager.searchNodes(query);
      // Prefer observations matching the query so a truncated search response
      // keeps the most relevant facts.
      return curatedToolResponse(graph, responseMaxBytes(), query);
    },
  );

  // Register open_nodes tool
  server.registerTool(
    "open_nodes",
    {
      title: "Open Nodes",
      description: "Open specific nodes in the knowledge graph by their names",
      inputSchema: {
        names: z.array(z.string()).describe("An array of entity names to retrieve"),
      },
      outputSchema: {
        entities: z.array(EntitySchema),
        relations: z.array(RelationSchema),
        truncated: TruncationInfoSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ names }) => {
      const graph = await manager.openNodes(names);
      return curatedToolResponse(graph, responseMaxBytes());
    },
  );

  registerKnowledgeGraphResource(server, manager);
  registerKnowledgeGraphSubscriptions(server);
  return server;
}
