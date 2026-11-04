import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";

export class StorageNotFoundError extends Error {
  constructor() {
    super("File not found in storage");
    this.name = "StorageNotFoundError";
  }
}

function safePath(root, key) {
  if (typeof key !== "string" || !key || path.isAbsolute(key)) throw new Error("Invalid storage key");
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Invalid storage key");
  return resolved;
}

export function createLocalStorage(directory) {
  const root = path.resolve(directory);
  const file = (key) => safePath(root, key);
  return {
    driver: "local",
    async put(key, sourcePath) {
      const target = file(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(sourcePath, target);
    },
    async getBuffer(key) {
      try {
        return await fs.readFile(file(key));
      } catch (err) {
        if (err?.code === "ENOENT") throw new StorageNotFoundError();
        throw err;
      }
    },
    async getStream(key) {
      const target = file(key);
      try {
        await fs.access(target);
      } catch (err) {
        if (err?.code === "ENOENT") throw new StorageNotFoundError();
        throw err;
      }
      return createReadStream(target);
    },
    async exists(key) {
      try {
        await fs.access(file(key));
        return true;
      } catch (err) {
        if (err?.code === "ENOENT") return false;
        throw err;
      }
    },
    async delete(key) {
      try {
        await fs.unlink(file(key));
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    },
  };
}
