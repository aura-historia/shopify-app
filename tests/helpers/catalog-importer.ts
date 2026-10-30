import { registerHooks } from "node:module";
import {
  type CatalogImports,
  catalogImportsOf,
} from "../../app/backfill.server";
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

// KV whose keys expire after their TTL on the (possibly mocked) clock.
export function memoryKv() {
  const entries = new Map<string, string>();
  // The expiration TTL of each stored key.
  const ttls = new Map<string, number | undefined>();
  const expiries = new Map<string, number>();
  return {
    entries,
    ttls,
    get: async (key: string) => {
      if (Date.now() >= (expiries.get(key) ?? Number.POSITIVE_INFINITY))
        entries.delete(key);
      return entries.get(key) ?? null;
    },
    put: async (
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) => {
      entries.set(key, value);
      ttls.set(key, options?.expirationTtl);
      if (options?.expirationTtl)
        expiries.set(key, Date.now() + options.expirationTtl * 1000);
      else expiries.delete(key);
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
export function importsOf(importer: Importer, shop: string): CatalogImports {
  return catalogImportsOf(importer, () => importer.begin(shop));
}
