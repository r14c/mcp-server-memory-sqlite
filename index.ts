#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KnowledgeGraphManager } from "./lib/manager.js";
import { ensureMemoryFilePath } from "./lib/paths.js";
import { buildServer } from "./lib/server.js";

// Re-export the public surface so existing consumers (and tests) can keep
// importing from the package root.
export { KnowledgeGraphManager } from "./lib/manager.js";
export {
  buildServer,
  registerKnowledgeGraphResource,
  registerKnowledgeGraphSubscriptions,
} from "./lib/server.js";
export { ensureMemoryFilePath, defaultMemoryPath } from "./lib/paths.js";
export type { Entity, Relation, KnowledgeGraph, Provenance } from "./lib/types.js";

async function main() {
  const memoryFilePath = await ensureMemoryFilePath();
  const manager = await KnowledgeGraphManager.open(memoryFilePath);
  const server = buildServer(manager);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
