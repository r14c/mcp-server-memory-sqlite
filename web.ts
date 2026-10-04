#!/usr/bin/env node

import { KnowledgeGraphManager } from "./lib/manager.js";
import { ensureMemoryFilePath } from "./lib/paths.js";
import { startWebServer } from "./lib/web/server.js";

async function main() {
  const memoryFilePath = await ensureMemoryFilePath();
  const manager = await KnowledgeGraphManager.open(memoryFilePath);
  const { server, url } = await startWebServer(manager, {
    port: Number(process.env.PORT ?? 3939),
    host: process.env.HOST ?? "127.0.0.1",
  });

  console.log(`Knowledge Graph web UI listening on ${url}`);
  console.log(`Database: ${memoryFilePath}`);

  // Close both resources cleanly on termination, whichever way it comes. The
  // database must be closed the way the MCP server does: close() folds the WAL
  // into the main file (wal_checkpoint) and refreshes query-plan statistics
  // (optimize). close() is synchronous, so it is safe to run from a signal
  // handler, and the guard makes the handlers idempotent (a SIGTERM racing
  // SIGINT must not close the database twice).
  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    manager.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run only when this module is the entry point (the installed bin, or `node
// dist/web.js`). Importing the package root must not start a second listener on
// the same database; `import.meta.main` needs Node >= 24.2.0 (see package.json
// engines), on older runtimes it is undefined and the server would silently
// never start.
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
  });
}
