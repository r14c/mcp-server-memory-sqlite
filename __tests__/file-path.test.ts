import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";
import { ensureMemoryFilePath, defaultMemoryPath } from "../index.js";

describe("ensureMemoryFilePath", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    // Save original environment variable
    originalEnv = process.env.MEMORY_FILE_PATH;
    // Delete environment variable
    delete process.env.MEMORY_FILE_PATH;
  });

  afterEach(() => {
    // Restore original environment variable
    if (originalEnv !== undefined) {
      process.env.MEMORY_FILE_PATH = originalEnv;
    } else {
      delete process.env.MEMORY_FILE_PATH;
    }
  });

  describe("with MEMORY_FILE_PATH environment variable", () => {
    it("should return absolute path when MEMORY_FILE_PATH is absolute", async () => {
      const absolutePath = "/tmp/custom-memory.db";
      process.env.MEMORY_FILE_PATH = absolutePath;

      const result = await ensureMemoryFilePath();

      expect(result).toBe(absolutePath);
    });

    it("should convert relative path to absolute when MEMORY_FILE_PATH is relative", async () => {
      const relativePath = "custom-memory.db";
      process.env.MEMORY_FILE_PATH = relativePath;

      const result = await ensureMemoryFilePath();

      expect(path.isAbsolute(result)).toBe(true);
      expect(result).toContain("custom-memory.db");
    });

    it("should redirect legacy .jsonl paths to a .db sibling", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      process.env.MEMORY_FILE_PATH = "/tmp/custom-memory.jsonl";
      const result = await ensureMemoryFilePath();

      expect(result).toBe("/tmp/custom-memory.db");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("DETECTED: /tmp/custom-memory.jsonl is a legacy JSONL memory file"),
      );

      consoleErrorSpy.mockRestore();
    });

    it("should redirect legacy .json paths to a .db sibling", async () => {
      process.env.MEMORY_FILE_PATH = "/tmp/custom-memory.json";
      const result = await ensureMemoryFilePath();

      expect(result).toBe("/tmp/custom-memory.db");
    });

    it("should handle Windows absolute paths", async () => {
      const windowsPath = "C:\\temp\\memory.db";
      process.env.MEMORY_FILE_PATH = windowsPath;

      const result = await ensureMemoryFilePath();

      // On Windows, should return as-is; on Unix, will be treated as relative
      if (process.platform === "win32") {
        expect(result).toBe(windowsPath);
      } else {
        expect(path.isAbsolute(result)).toBe(true);
      }
    });
  });

  describe("without MEMORY_FILE_PATH environment variable", () => {
    it("should return default path when no files exist", async () => {
      const result = await ensureMemoryFilePath();

      expect(result).toBe(defaultMemoryPath);
    });
  });

  describe("defaultMemoryPath", () => {
    it("should end with memory.db", () => {
      expect(defaultMemoryPath).toMatch(/memory\.db$/);
    });

    it("should be an absolute path", () => {
      expect(path.isAbsolute(defaultMemoryPath)).toBe(true);
    });
  });
});
