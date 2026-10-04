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
export { createApp, startWebServer } from "./lib/web/server.js";
export type { RunningWebServer, WebServerOptions } from "./lib/web/server.js";
export type {
  DeleteEntitiesResult,
  DeleteObservationsResult,
  Entity,
  KnowledgeGraph,
  Provenance,
  Relation,
  UpdateObservationsResult,
} from "./lib/types.js";

async function main() {
  const memoryFilePath = await ensureMemoryFilePath();
  const manager = await KnowledgeGraphManager.open(memoryFilePath);
  const server = buildServer(manager);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");

  // Close the database cleanly on termination, whichever way it comes. close()
  // folds the WAL into the main file (wal_checkpoint) and refreshes query-plan
  // statistics (optimize); without this wiring the -wal/-shm sidecars are
  // abandoned on every exit. close() is synchronous, so it is safe to run from
  // a signal handler, and the guard makes the handlers idempotent (a SIGTERM
  // racing stdin close must not close the database twice). Signals exit
  // immediately; stdin close just closes the manager and lets the process
  // drain naturally so any pending stdout writes flush first.
  let closed = false;
  const closeManager = () => {
    if (closed) return;
    closed = true;
    manager.close();
  };
  const shutdown = () => {
    closeManager();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", closeManager);
}

// Run only when this module is the entry point (the installed bin, or `node
// dist/index.js`). Importing the package root must not start a server: the
// test suite imports it for the re-exports, and a module-scope main() would
// open the scratch database and open a stdio transport in every test file —
// concurrent workers then race on that database and main() rejects.
// `import.meta.main` needs Node >= 24.2.0 (see package.json engines); on older
// runtimes it is undefined and the server would silently never start.
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
