import path from "path";
import { fileURLToPath } from "url";

// The module directory is the parent of lib/ so that, as in the original
// single-file layout, the default database lives next to index.js (repo root
// under source, dist/ under the compiled output).
const moduleDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// SQLite database file used for persistent storage.
export const defaultMemoryPath = path.join(moduleDir, "memory.db");

// Resolve the SQLite database path. MEMORY_FILE_PATH may still point at a
// legacy JSONL document from earlier versions; in that case we redirect the
// database to a sibling .db file and import the JSONL contents on first open.
export async function ensureMemoryFilePath(): Promise<string> {
  let resolved: string;
  if (process.env.MEMORY_FILE_PATH) {
    // Custom path provided, use it as-is (with absolute path resolution).
    resolved = path.isAbsolute(process.env.MEMORY_FILE_PATH)
      ? process.env.MEMORY_FILE_PATH
      : path.join(moduleDir, process.env.MEMORY_FILE_PATH);
  } else {
    resolved = defaultMemoryPath;
  }

  if (/\.jsonl?$/i.test(resolved)) {
    const dbPath = resolved.replace(/\.jsonl?$/i, ".db");
    console.error(
      `DETECTED: ${resolved} is a legacy JSONL memory file; the SQLite database will be created at ${dbPath} and the JSONL contents imported on first start`,
    );
    return dbPath;
  }
  return resolved;
}
