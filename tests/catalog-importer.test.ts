import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it, mock } from "node:test";
import {
  type BackfillContext,
  type CatalogImportJob,
  storeBackfillContext,
} from "../app/backfill.server";
import { loadCatalogImportStatus } from "../app/catalog.server";
import type { CloudflareShopifyEnv } from "../app/shopify.server";

// Run the actual importer against isolated storage and the platform base
// class shim. No live Shopify installation, Cloudflare binding or Aura source.
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
const { CatalogImporter, CATALOG_MAX_ATTEMPTS } = await import(
  "../workers/catalog-importer"
);

const shop = "importer.myshopify.com";
const bulkOperationId = "gid://shopify/BulkOperation/321";
const publicationId = "gid://shopify/Publication/654";
const resultUrl = "https://cdn.shopify.com/importer.jsonl";
const backfillKey = `aura-historia:backfill:${shop}`;

class MemoryStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async deleteAll() {
    this.values.clear();
  }
  async setAlarm(time: number) {
    this.alarm = time;
  }
}

function context(): BackfillContext {
  return {
    listingSourceId: `ls_${"0".repeat(26)}`,
    accessToken: "aura-private-token",
    apiBaseUrl: "https://aura.invalid",
    currencyCode: "EUR",
    shopDomain: shop,
    bulkOperationId,
    publicationId,
    createdAt: "2026-10-27T10:00:00.000Z",
  };
}

const product = {
  id: "gid://shopify/Product/77",
  title: "Clock",
  handle: "clock",
  status: "ACTIVE",
  totalInventory: 1,
  tracksInventory: true,
  onlineStoreUrl: null,
  publishedOnPublication: true,
};

async function runtime(graphql: (query: string) => Promise<unknown>) {
  const storage = new MemoryStorage();
  const kv = new Map<string, string>();
  const env = {
    KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    },
    SHOP_COORDINATOR: {
      getByName: (name: string) => {
        assert.equal(name, shop);
        return {
          graphql: (_shop: string, query: string) => graphql(query),
        };
      },
    },
  } as unknown as CloudflareShopifyEnv;
  await storeBackfillContext(env.KV, shop, context());
  const importer = Reflect.construct(CatalogImporter, [{ storage }, env]) as {
    start(shop: string, bulkOperationId: string): Promise<void>;
    alarm(): Promise<void>;
  };
  return { storage, kv, env, importer };
}

function shopify({ fail = false } = {}) {
  return mock.fn(async (query: string) => {
    if (fail) throw new Error("Shopify unavailable");
    if (query.includes("AuraChannelAccess"))
      return {
        data: {
          currentAppInstallation: {
            accessScopes: [{ handle: "read_product_listings" }],
          },
        },
      };
    if (query.includes("AuraChannelPublication"))
      return {
        data: {
          currentAppInstallation: { publication: { id: publicationId } },
        },
      };
    return {
      data: {
        node: {
          status: "COMPLETED",
          objectCount: "1",
          rootObjectCount: "1",
          url: resultUrl,
        },
      },
    };
  });
}

async function withFetch(fetcher: typeof fetch, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

// The source already lists product 77 and an unselected product 78.
const aura = () =>
  mock.fn(async (input: RequestInfo | URL) => {
    const request = new Request(input);
    if (request.url === resultUrl) return new Response(JSON.stringify(product));
    if (request.method === "GET")
      return Response.json({
        items: ["77", "78"].map((sourceListingId) => ({
          sourceListingId,
          lifecycle: "ACTIVE",
        })),
        size: 2,
      });
    const body = (await request.json()) as unknown[];
    return Response.json(
      { submissionId: "s", acceptedCount: body.length, failures: [] },
      { status: 202 },
    );
  });

describe("catalog importer durable object", () => {
  it("imports in alarms, records the outcome and releases the context", async () => {
    const { storage, kv, importer } = await runtime(shopify());
    await importer.start(shop, bulkOperationId);
    assert.ok(storage.alarm);
    const fetcher = aura();
    await withFetch(fetcher as typeof fetch, () => importer.alarm());
    const status = await loadCatalogImportStatus(
      { get: async (key: string) => kv.get(key) ?? null } as never,
      shop,
    );
    assert.equal(status?.phase, "submitted");
    assert.equal(status?.eligible, 1);
    assert.equal(status?.withdrawn, 1);
    // Job, retained enumeration and withdrawal batches are all released.
    assert.equal(storage.values.size, 0);
    assert.equal(kv.has(backfillKey), false);
    // Export download, one listing page, one upsert and one withdrawal batch.
    assert.equal(fetcher.mock.callCount(), 4);
  });

  it("does not restart an admitted import on duplicate completion webhooks", async () => {
    const { storage, importer } = await runtime(shopify());
    await importer.start(shop, bulkOperationId);
    const job = (await storage.get<CatalogImportJob>(
      "job",
    )) as CatalogImportJob;
    job.cursor = 3;
    await storage.put("job", job);
    await storage.put("withdraw:0", ["78"]);
    await importer.start(shop, bulkOperationId);
    assert.equal((await storage.get<CatalogImportJob>("job"))?.cursor, 3);
    assert.ok(storage.values.has("withdraw:0"));
    // A newer export discards the superseded job's retained data.
    await importer.start(shop, "gid://shopify/BulkOperation/999");
    assert.equal((await storage.get<CatalogImportJob>("job"))?.cursor, 0);
    assert.equal(storage.values.has("withdraw:0"), false);
  });

  it("stops without writes once the import was superseded or disconnected", async () => {
    const { storage, kv, importer } = await runtime(shopify());
    await importer.start(shop, bulkOperationId);
    kv.delete(backfillKey);
    const fetcher = aura();
    await withFetch(fetcher as typeof fetch, () => importer.alarm());
    assert.equal(fetcher.mock.callCount(), 0);
    assert.equal(storage.values.has("job"), false);
  });

  it("retries failed Shopify reads with backoff, then reports a retryable failure", async () => {
    const { storage, kv, importer } = await runtime(shopify({ fail: true }));
    await importer.start(shop, bulkOperationId);
    const fetcher = aura();
    await withFetch(fetcher as typeof fetch, async () => {
      for (let attempt = 1; attempt < CATALOG_MAX_ATTEMPTS; attempt++) {
        const before = Date.now();
        await importer.alarm();
        assert.equal(
          (await storage.get<CatalogImportJob>("job"))?.attempts,
          attempt,
        );
        assert.ok((storage.alarm ?? 0) >= before + 1000 * 2 ** attempt);
      }
      await importer.alarm();
    });
    assert.equal(fetcher.mock.callCount(), 0);
    assert.equal(storage.values.has("job"), false);
    const status = await loadCatalogImportStatus(
      { get: async (key: string) => kv.get(key) ?? null } as never,
      shop,
    );
    assert.equal(status?.phase, "failed");
    assert.equal(status?.error, "SHOPIFY_READ_FAILED");
  });
});
