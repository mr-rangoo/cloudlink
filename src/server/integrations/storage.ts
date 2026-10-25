import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@/server/errors";

/**
 * Object storage adapter. Keys are always generated server-side (never from user input).
 * - local: files under STORAGE_LOCAL_DIR (development / single-node deployments).
 * - s3: not implemented yet; reports INTEGRATION_UNAVAILABLE so nothing pretends to be stored.
 */
export interface StorageAdapter {
  name: "local" | "s3";
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const KEY_RE = /^[a-z0-9][a-z0-9/._-]{0,200}$/;

function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes("..")) throw new AppError("INTERNAL_ERROR", "Invalid storage key.");
}

class LocalStorage implements StorageAdapter {
  name = "local" as const;
  constructor(private readonly root: string) {}
  private resolve(key: string) {
    assertKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new AppError("INTERNAL_ERROR", "Invalid storage path.");
    return full;
  }
  async put(key: string, data: Buffer) {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { flag: "wx" }); // never overwrite
  }
  async get(key: string) {
    try {
      return await readFile(this.resolve(key));
    } catch {
      throw new AppError("NOT_FOUND", "The file is no longer available.");
    }
  }
  async remove(key: string) {
    await rm(this.resolve(key), { force: true });
  }
}

class UnavailableStorage implements StorageAdapter {
  name = "s3" as const;
  private fail(): never {
    throw new AppError("INTEGRATION_UNAVAILABLE", "File storage (S3) is not configured yet.");
  }
  async put() {
    this.fail();
  }
  async get(): Promise<Buffer> {
    this.fail();
  }
  async remove() {
    this.fail();
  }
}

let adapter: StorageAdapter | undefined;
export function storage(): StorageAdapter {
  if (!adapter) {
    adapter = (process.env.STORAGE_ADAPTER ?? "local") === "local" ? new LocalStorage(path.resolve(process.env.STORAGE_LOCAL_DIR ?? "storage")) : new UnavailableStorage();
  }
  return adapter;
}

export function resetStorageForTests(root: string) {
  adapter = new LocalStorage(root);
}
