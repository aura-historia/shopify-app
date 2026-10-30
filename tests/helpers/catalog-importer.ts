import { registerHooks } from "node:module";
import type { CatalogImports } from "../../app/backfill.server";
import type { CloudflareShopifyEnv } from "../../app/shopify.server";
import type { CatalogImporter as Importer } from "../../workers/catalog-importer";

// Run the actual importer against isolated storage and the platform base
// class shim. No live Cloudflare binding.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: `data:text/javascript,${encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }")}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { CatalogImporter } = await import("../../workers/catalog-importer");

// Durable Object storage whose transactions run one at a time. `before`
// runs ahead of the next transaction, to interleave a concurrent request.
export class ImporterStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  transactions = 0;
  before: (() => Promise<void>) | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(time: number) {
    this.alarm = time;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
  async transaction<T>(callback: (storage: ImporterStorage) => Promise<T>) {
    const before = this.before;
    this.before = null;
    await before?.();
    this.transactions++;
    const result = this.tail.then(() => callback(this));
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export function memoryKv() {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string, _options?: unknown) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
  };
}

export type CatalogImporterInstance = Importer;

export function createImporter(
  storage: ImporterStorage,
  env: Pick<CloudflareShopifyEnv, "KV"> & Partial<CloudflareShopifyEnv>,
): Importer {
  return Reflect.construct(CatalogImporter, [{ storage }, env]);
}

// Imports begun directly, as the coordinator does for its bound connection.
export function importsOf(
  importer: () => Importer,
  shop: string,
): CatalogImports {
  return {
    begin: () => importer().begin(shop),
    queue: (generation, context) => importer().queue(generation, context),
    fail: (generation, error) => importer().fail(generation, error),
    status: () => importer().status(),
  };
}
