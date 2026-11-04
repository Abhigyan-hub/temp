import path from "node:path";
import { env } from "../../config/env.js";
import { createLocalStorage, StorageNotFoundError } from "./local.js";
import { createS3Storage } from "./s3.js";

export { StorageNotFoundError };

export class StorageUnavailableError extends Error {
  constructor(message = "File storage is not configured") {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

let storageOverride;
let configuredStorage;

function configured() {
  if (configuredStorage) return configuredStorage;
  const driver = env.STORAGE_DRIVER || (env.S3_BUCKET ? "s3" : env.isProd ? "s3" : "local");
  if (driver === "s3") {
    if (!env.S3_BUCKET) throw new StorageUnavailableError("S3_BUCKET is required for file storage");
    configuredStorage = createS3Storage(env);
  } else {
    const directory = path.isAbsolute(env.LOCAL_STORAGE_DIR) ? env.LOCAL_STORAGE_DIR : path.resolve(process.cwd(), env.LOCAL_STORAGE_DIR);
    configuredStorage = createLocalStorage(directory);
  }
  return configuredStorage;
}

export function getStorage() {
  return storageOverride ?? configured();
}

export function setStorage(storage) {
  storageOverride = storage;
}

export function storageStatus() {
  try {
    return { driver: getStorage().driver, available: true };
  } catch (err) {
    return { driver: env.STORAGE_DRIVER || (env.S3_BUCKET ? "s3" : env.isProd ? "s3" : "local"), available: false, message: err.message };
  }
}
