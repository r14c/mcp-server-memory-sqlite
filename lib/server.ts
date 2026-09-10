import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { KnowledgeGraphManager } from "./manager.js";
import type { KnowledgeGraph, Provenance } from "./types.js";
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

// Far endpoints of `relations` that are not in `entities`, so following an edge
// does not need a second call. Declared in the graph tools' outputSchema
// because zod emits `additionalProperties: false`: an undeclared response field
// makes conformant clients reject the whole result.
const NeighborsSchema = z
  .array(EntitySchema)
  .describe(
    "Far endpoints of `relations` that are not in `entities`, so following an edge does not " +
      "need a second call. Deduped, in rowid order; empty when the result set is closed.",
  );

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

// Build the MCP server: register the ten tools, the knowledge-graph resource,
// and the subscription capability. Upstream's nine tools keep their upstream
// signatures — a caller written against upstream keeps working — while extra
// response fields (neighbors, delete counts) and one added verb
// (update_observations, since an edit as delete-plus-add is unverifiable) are
// layered on top. Semantics may diverge where upstream's are misleading or
// lossy: deletes report what matched, and relation endpoints come back with
// the edges that name them.
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

  // Every graph read returns the same shape: the matched entities, the
  // relations touching them, and the far endpoints of those relations. The
  // server returns the full result and leaves the bound to the client, which
  // spills an oversized result to a file it hands back (see README).
  const graphResponse = (graph: KnowledgeGraph) => ({
    content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
    structuredContent: { ...graph },
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
        deletedEntities: z.array(
          z.object({ entityName: z.string().describe("The canonical name that was removed") }),
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ entityNames }) => {
      const deleted = await manager.deleteEntities(entityNames);
      notifyGraphUpdated();
      // Report what matched: the request stays idempotent (a name that is
      // already gone is not an error), but the caller can tell a typo from a
      // completed deletion instead of trusting a blanket success.
      const message = `Deleted ${deleted.length} of ${entityNames.length} requested entities`;
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: { success: true, message, deletedEntities: deleted },
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
        results: z.array(
          z.object({
            entityName: z.string(),
            deletedObservations: z.array(z.string()),
          }),
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ deletions }) => {
      const deleted = await manager.deleteObservations(deletions);
      notifyGraphUpdated();
      // The count is the point: upstream reports success whether or not the
      // text matched, which made every edit a guess.
      const total = deleted.reduce((sum, result) => sum + result.deletedObservations.length, 0);
      const requested = deletions.reduce((sum, deletion) => sum + deletion.observations.length, 0);
      const message = `Deleted ${total} of ${requested} requested observations`;
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: { success: true, message, results: deleted },
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
        deletedRelations: z.array(RelationSchema),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ relations }) => {
      const deleted = await manager.deleteRelations(relations);
      notifyGraphUpdated();
      const message = `Deleted ${deleted.length} of ${relations.length} requested relations`;
      return {
        content: [{ type: "text" as const, text: message }],
        structuredContent: { success: true, message, deletedRelations: deleted },
      };
    },
  );

  // Register update_observations tool
  server.registerTool(
    "update_observations",
    {
      title: "Update Observations",
      description:
        "Replace the text of existing observations in place, addressed by their exact current " +
        "content. Upstream has no update verb, so an edit is a delete plus an add: two calls, " +
        "non-atomic, and unverifiable. This fails loudly if the match is absent or the replacement " +
        "already exists, and it keeps the observation's created_at while recording updated_at.",
      inputSchema: {
        updates: z.array(
          z.object({
            entityName: z.string().describe("The name of the entity holding the observation"),
            match: z.string().describe("The exact current content of the observation to replace"),
            replacement: z.string().describe("The new content"),
          }),
        ),
      },
      outputSchema: {
        results: z.array(
          z.object({
            entityName: z.string(),
            updatedObservations: z.array(z.string()),
          }),
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ updates }) => {
      const result = await manager.updateObservations(updates);
      notifyGraphUpdated();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        structuredContent: { results: result },
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
        neighbors: NeighborsSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      return graphResponse(await manager.readGraph());
    },
  );

  // Register search_nodes tool
  server.registerTool(
    "search_nodes",
    {
      title: "Search Nodes",
      description:
        "Search for nodes in the knowledge graph based on a query. Relations come back with their " +
        "far endpoints in `neighbors`, so one search shows the surrounding graph.",
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
        neighbors: NeighborsSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query }) => {
      return graphResponse(await manager.searchNodes(query));
    },
  );

  // Register open_nodes tool
  server.registerTool(
    "open_nodes",
    {
      title: "Open Nodes",
      description:
        "Open specific nodes in the knowledge graph by their names. Relations come back with their " +
        "far endpoints in `neighbors`, so one call returns a node and everything it points at.",
      inputSchema: {
        names: z.array(z.string()).describe("An array of entity names to retrieve"),
      },
      outputSchema: {
        entities: z.array(EntitySchema),
        relations: z.array(RelationSchema),
        neighbors: NeighborsSchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ names }) => {
      return graphResponse(await manager.openNodes(names));
    },
  );

  registerKnowledgeGraphResource(server, manager);
  registerKnowledgeGraphSubscriptions(server);
  return server;
}
