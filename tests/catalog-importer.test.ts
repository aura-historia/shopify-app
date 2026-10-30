import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  type BackfillContext,
  type CatalogImportJob,
  loadBackfillContext,
} from "../app/backfill.server";
import type { CloudflareShopifyEnv } from "../app/shopify.server";
import {
  type CatalogImporterInstance,
  createImporter,
  ImporterStorage,
  importsOf,
  memoryKv,
} from "./helpers/catalog-importer";
import { channelResponse, isChannelQuery } from "./helpers/channel-fixtures";

const { CATALOG_MAX_ATTEMPTS } = await import("../workers/catalog-importer");

const shop = "importer.myshopify.com";
const bulkOperationId = "gid://shopify/BulkOperation/321";
const newerOperationId = "gid://shopify/BulkOperation/654";
const publicationId = "gid://shopify/Publication/654";
const resultUrl = "https://cdn.shopify.com/importer.jsonl";
const contextKey = (generation: number) =>
  `aura-historia:backfill:${shop}:${generation}`;

function context(overrides: Partial<BackfillContext> = {}): BackfillContext {
  return {
    listingSourceId: `ls_${"0".repeat(26)}`,
    accessToken: "aura-private-token",
    apiBaseUrl: "https://aura.invalid",
    currencyCode: "EUR",
    shopDomain: shop,
    bulkOperationId,
    publicationId,
    createdAt: "2026-10-27T10:00:00.000Z",
    ...overrides,
  };
}

// An export with `count` active products published to the channel. More than
// 100 products need several batches.
function catalog(count = 1) {
  return Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      id: `gid://shopify/Product/${index + 1}`,
      title: "Clock",
      handle: `clock-${index + 1}`,
      status: "ACTIVE",
      totalInventory: 1,
      tracksInventory: true,
      onlineStoreUrl: null,
      publishedOnPublication: true,
    }),
  ).join("\n");
}

function shopify({ fail = false, publicationFailures = 0, products = 1 } = {}) {
  let publicationReads = 0;
  return mock.fn(async (query: string, variables: Record<string, unknown>) => {
    if (fail) throw new Error("Shopify unavailable");
    if (
      query.includes("AuraChannelCatalogPublication") &&
      publicationReads++ < publicationFailures
    )
      throw new Error("Network connection lost");
    if (isChannelQuery(query))
      return channelResponse(
        query,
        {
          scopes: ["read_product_listings", "read_publications"],
          publication: { id: publicationId },
        },
        variables,
      );
    return {
      data: {
        node: {
          status: "COMPLETED",
          objectCount: String(products),
          rootObjectCount: String(products),
          url: resultUrl,
        },
      },
    };
  });
}

function importerRuntime(graphql = shopify()) {
  const storage = new ImporterStorage();
  const kv = memoryKv();
  const env = {
    KV: kv,
    SHOP_COORDINATOR: {
      getByName: (name: string) => {
        assert.equal(name, shop);
        return {
          graphql: (
            _shop: string,
            query: string,
            variables: Record<string, unknown>,
          ) => graphql(query, variables),
        };
      },
    },
  } as unknown as CloudflareShopifyEnv;
  let importer: CatalogImporterInstance = createImporter(storage, env);
  return {
    storage,
    kv,
    get importer() {
      return importer;
    },
    get imports() {
      return importsOf(importer, shop);
    },
    // A new instance on the same storage, as after eviction.
    evict() {
      importer = createImporter(storage, env);
    },
    job: () => storage.get<CatalogImportJob>("job"),
    // Begins an import and queues its finished export, as triggerBackfill
    // and the completion webhook do.
    async admitted(overrides: Partial<BackfillContext> = {}) {
      const imports = importsOf(importer, shop);
      const generation = (await imports.begin()) as number;
      assert.equal(await imports.queue(generation, context(overrides)), true);
      await importer.start(overrides.bulkOperationId ?? bulkOperationId);
      return generation;
    },
  };
}

interface AuraRequest {
  method: string;
  key: string | null;
  token: string | null;
  items: number;
}

// Shopify's export download and Aura's batch admission. `onBatch` runs while
// a batch request is in flight.
function network(
  products = catalog(),
  {
    onDownload = async () => {},
    onBatch = async (_request: AuraRequest) =>
      undefined as Response | undefined,
  } = {},
) {
  const batches: AuraRequest[] = [];
  const fetcher = mock.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === resultUrl) {
        await onDownload();
        return new Response(products);
      }
      const body = (await request.json()) as unknown[];
      const batch = {
        method: request.method,
        key: request.headers.get("Idempotency-Key"),
        token: request.headers.get("Authorization"),
        items: body.length,
      };
      batches.push(batch);
      return (
        (await onBatch(batch)) ??
        Response.json(
          { submissionId: "s", acceptedCount: body.length, failures: [] },
          { status: 202 },
        )
      );
    },
  );
  return { batches, fetcher };
}

async function withFetch(fetcher: unknown, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

describe("catalog importer durable object", () => {
  it("imports in alarms, records the outcome and releases the context", async () => {
    const runtime = importerRuntime();
    const generation = await runtime.admitted();
    assert.ok(runtime.storage.alarm);
    assert.ok(runtime.kv.entries.has(contextKey(generation)));
    const { batches, fetcher } = network();
    await withFetch(fetcher, () => runtime.importer.alarm());
    const status = await runtime.importer.status();
    assert.equal(status?.phase, "submitted");
    assert.equal(status?.eligible, 1);
    assert.equal(await runtime.job(), undefined);
    assert.equal(runtime.kv.entries.has(contextKey(generation)), false);
    // One export download and one admitted upsert batch.
    assert.equal(fetcher.mock.callCount(), 2);
    assert.deepEqual(
      batches.map(({ key }) => key),
      ["shopify-backfill-321-put-0"],
    );
  });

  it("admits only the current generation's export, once", async () => {
    const { storage, imports, importer, job } = importerRuntime();
    // Nothing is admitted before an import queued its export.
    await importer.start(bulkOperationId);
    assert.equal(storage.alarm, null);
    const generation = (await imports.begin()) as number;
    assert.equal((await imports.status())?.phase, "queued");
    await importer.start(bulkOperationId);
    assert.equal(storage.alarm, null);
    await imports.queue(generation, context());
    await importer.start("gid://shopify/BulkOperation/999");
    assert.equal((await job())?.admitted, false);
    await importer.start(bulkOperationId);
    const admitted = (await job()) as CatalogImportJob;
    assert.equal(admitted.admitted, true);
    assert.equal(admitted.generation, generation);
    // A duplicate never restarts the import or skips its pending backoff.
    await storage.put("job", { ...admitted, cursor: 3 });
    storage.alarm = Date.now() + 60_000;
    await importer.start(bulkOperationId);
    assert.equal((await job())?.cursor, 3);
    assert.ok(storage.alarm > Date.now() + 30_000);
    // A lost alarm is rearmed.
    storage.alarm = null;
    await importer.start(bulkOperationId);
    assert.ok(storage.alarm && storage.alarm <= Date.now());
    assert.equal((await job())?.cursor, 3);
  });

  it("retries failed Shopify reads with backoff, then reports a retryable failure", async () => {
    const { storage, kv, importer, job, admitted } = importerRuntime(
      shopify({ fail: true }),
    );
    const generation = await admitted();
    const { fetcher } = network();
    await withFetch(fetcher, async () => {
      for (let attempt = 1; attempt < CATALOG_MAX_ATTEMPTS; attempt++) {
        const before = Date.now();
        await importer.alarm();
        assert.equal((await job())?.attempts, attempt);
        assert.ok((storage.alarm ?? 0) >= before + 1000 * 2 ** attempt);
      }
      await importer.alarm();
    });
    assert.equal(fetcher.mock.callCount(), 0);
    assert.equal(await job(), undefined);
    const status = await importer.status();
    assert.equal(status?.phase, "failed");
    assert.equal(status?.error, "SHOPIFY_READ_FAILED");
    assert.equal(kv.entries.has(contextKey(generation)), false);
  });

  it("retries an unreadable publication with backoff and then completes", async () => {
    const { kv, importer, job, admitted } = importerRuntime(
      shopify({ publicationFailures: 1 }),
    );
    const generation = await admitted();
    const { fetcher } = network();
    await withFetch(fetcher, async () => {
      await importer.alarm();
      assert.equal((await job())?.attempts, 1);
      assert.ok(kv.entries.has(contextKey(generation)));
      assert.equal(fetcher.mock.callCount(), 0);
      await importer.alarm();
    });
    assert.equal((await importer.status())?.phase, "submitted");
    assert.equal(await job(), undefined);
  });

  it("reports a missing context as a retryable failure without submitting", async () => {
    const { kv, importer, job, admitted } = importerRuntime();
    const generation = await admitted();
    // For example, the context expired before Shopify finished the export.
    kv.entries.delete(contextKey(generation));
    const { fetcher } = network();
    await withFetch(fetcher, async () => {
      for (let attempt = 0; attempt < CATALOG_MAX_ATTEMPTS; attempt++)
        await importer.alarm();
    });
    assert.equal(fetcher.mock.callCount(), 0);
    assert.equal(await job(), undefined);
    assert.equal((await importer.status())?.error, "SHOPIFY_READ_FAILED");
  });

  it("records a failed Shopify export only for the current generation", async () => {
    const { storage, kv, imports, importer, job } = importerRuntime();
    const generation = (await imports.begin()) as number;
    await imports.queue(generation, context());
    await importer.exportFailed("gid://shopify/BulkOperation/999");
    assert.equal((await imports.status())?.phase, "queued");
    await importer.exportFailed(bulkOperationId);
    const status = await imports.status();
    assert.equal(status?.phase, "failed");
    assert.equal(status?.error, "SHOPIFY_READ_FAILED");
    assert.equal(await job(), undefined);
    assert.equal(kv.entries.has(contextKey(generation)), false);
    // A late completion of the failed export admits nothing.
    await importer.start(bulkOperationId);
    assert.equal(storage.alarm, null);
  });

  it("never admits a job from before import generations", async () => {
    const { storage, importer } = importerRuntime();
    await storage.put("job", {
      shop,
      bulkOperationId,
      cursor: 0,
      failed: 0,
      withdrawn: 0,
      attempts: 0,
    });
    await importer.start(bulkOperationId);
    assert.equal(storage.alarm, null);
    assert.equal(
      (await storage.get<CatalogImportJob>("job"))?.admitted,
      undefined,
    );
  });

  it("keeps a failed context release from blocking a stop", async () => {
    const { kv, importer, job, admitted } = importerRuntime();
    const generation = await admitted();
    const attempts: string[] = [];
    kv.delete = async (key: string) => {
      attempts.push(key);
      throw new Error("KV put failed: 429 Too Many Requests");
    };
    const warn = mock.method(console, "warn", () => {});
    try {
      await importer.stop();
    } finally {
      warn.mock.restore();
    }
    // The fence holds; only the expiring credential copy remains.
    assert.equal(await job(), undefined);
    assert.deepEqual(attempts, Array(3).fill(contextKey(generation)));
    assert.equal(warn.mock.callCount(), 1);
  });

  it("records why a generation could not start its export", async () => {
    const { imports } = importerRuntime();
    const older = (await imports.begin()) as number;
    const generation = (await imports.begin()) as number;
    assert.ok(generation > older);
    assert.equal(await imports.fail(older, "MISSING_SCOPE"), false);
    assert.equal((await imports.status())?.phase, "queued");
    assert.equal(await imports.fail(generation, "MISSING_SCOPE"), true);
    assert.equal((await imports.status())?.error, "MISSING_SCOPE");
  });
});

describe("catalog import generations", () => {
  it("submits nothing once disconnected during the export download", async () => {
    const runtime = importerRuntime();
    const generation = await runtime.admitted();
    const { batches, fetcher } = network(catalog(), {
      onDownload: () => runtime.importer.stop(),
    });
    await withFetch(fetcher, () => runtime.importer.alarm());
    assert.deepEqual(batches, []);
    assert.equal(await runtime.job(), undefined);
    assert.equal(await runtime.importer.status(), null);
    assert.equal(runtime.storage.alarm, null);
    assert.equal(runtime.kv.entries.has(contextKey(generation)), false);
    // Delayed or duplicate completion webhooks and alarm retries find nothing
    // to revive, also on a new instance after eviction.
    runtime.evict();
    await runtime.importer.start(bulkOperationId);
    await runtime.importer.exportFailed(bulkOperationId);
    await withFetch(fetcher, () => runtime.importer.alarm());
    assert.deepEqual(batches, []);
    assert.equal(runtime.storage.alarm, null);
    assert.equal(await runtime.importer.status(), null);
  });

  it("initiates no further batch once disconnected between batches", async () => {
    const runtime = importerRuntime(shopify({ products: 150 }));
    await runtime.admitted();
    let stopped = false;
    const { batches, fetcher } = network(catalog(150), {
      // The stop is acknowledged while the first batch is in flight.
      onBatch: async () => {
        if (!stopped) await runtime.importer.stop();
        stopped = true;
        return undefined;
      },
    });
    await withFetch(fetcher, () => runtime.importer.alarm());
    // The in-flight batch completes; the second one is never sent.
    assert.deepEqual(
      batches.map(({ key, items }) => [key, items]),
      [["shopify-backfill-321-put-0", 100]],
    );
    assert.equal(await runtime.job(), undefined);
    assert.equal(await runtime.importer.status(), null);
    assert.equal(runtime.storage.alarm, null);
  });

  it("resends nothing for a batch whose import was stopped in flight", async () => {
    const runtime = importerRuntime();
    await runtime.admitted();
    const { batches, fetcher } = network(catalog(), {
      // An unconfirmed admission would normally be resent with its key.
      onBatch: async () => {
        await runtime.importer.stop();
        return new Response(null, { status: 503 });
      },
    });
    await withFetch(fetcher, () => runtime.importer.alarm());
    assert.equal(batches.length, 1);
    assert.equal(await runtime.job(), undefined);
    assert.equal(await runtime.importer.status(), null);
  });

  it("hands submission authority to a newer import as soon as it begins", async () => {
    const runtime = importerRuntime();
    const older = await runtime.admitted();
    let newer = 0;
    const replacement = network(catalog(), {
      // "Import catalog again" or a new connection starts while the older
      // alarm downloads its export, before Shopify finished the new export.
      onDownload: async () => {
        newer = (await runtime.imports.begin()) as number;
      },
    });
    await withFetch(replacement.fetcher, () => runtime.importer.alarm());
    assert.deepEqual(replacement.batches, []);
    assert.equal(runtime.kv.entries.has(contextKey(older)), false);
    assert.equal(await runtime.job(), undefined);
    assert.equal(runtime.storage.alarm, null);
    assert.equal((await runtime.importer.status())?.phase, "queued");

    assert.equal(
      await runtime.imports.queue(
        newer,
        context({
          bulkOperationId: newerOperationId,
          accessToken: "aura-newer-token",
        }),
      ),
      true,
    );
    // A delayed completion of the older export admits nothing.
    await runtime.importer.start(bulkOperationId);
    assert.equal(runtime.storage.alarm, null);
    await runtime.importer.start(newerOperationId);
    const { batches, fetcher } = network();
    await withFetch(fetcher, () => runtime.importer.alarm());
    assert.deepEqual(batches, [
      {
        method: "PUT",
        key: "shopify-backfill-654-put-0",
        token: "Bearer aura-newer-token",
        items: 1,
      },
    ]);
    assert.equal((await runtime.importer.status())?.phase, "submitted");
  });

  it("ignores the completion of an export replaced before Shopify finished it", async () => {
    const { storage, kv, imports, importer, job } = importerRuntime();
    const older = (await imports.begin()) as number;
    await imports.queue(older, context());
    const newer = (await imports.begin()) as number;
    assert.equal(kv.entries.has(contextKey(older)), false);
    // The older generation can no longer queue or fail anything either.
    assert.equal(await imports.queue(older, context()), false);
    assert.equal(kv.entries.has(contextKey(older)), false);
    await imports.queue(newer, context({ bulkOperationId: newerOperationId }));
    await importer.start(bulkOperationId);
    await importer.exportFailed(bulkOperationId);
    assert.equal(storage.alarm, null);
    assert.equal((await job())?.bulkOperationId, newerOperationId);
    assert.equal((await job())?.admitted, false);
    assert.equal((await imports.status())?.phase, "queued");
    assert.ok(kv.entries.has(contextKey(newer)));
  });

  it("never lets an older import's final writes reach a newer one", async () => {
    // A newer import begins just before the older one's outcome commits, or
    // begins and queues its export between that commit and the release of
    // the older context.
    for (const moment of ["outcome", "release"] as const) {
      const runtime = importerRuntime();
      const older = await runtime.admitted();
      let newer = 0;
      const replace = async () => {
        newer = (await runtime.imports.begin()) as number;
        await runtime.imports.queue(
          newer,
          context({ bulkOperationId: newerOperationId }),
        );
      };
      const kvDelete = runtime.kv.delete;
      let replaced = false;
      if (moment === "release")
        runtime.kv.delete = async (key: string) => {
          if (key === contextKey(older) && !replaced) {
            replaced = true;
            await replace();
          }
          await kvDelete(key);
        };
      const { fetcher } = network(catalog(), {
        onBatch: async () => {
          // Only the transaction after the batch's checkpoint is left.
          if (moment === "outcome")
            runtime.storage.before = async () => {
              runtime.storage.before = replace;
            };
          return undefined;
        },
      });
      await withFetch(fetcher, () => runtime.importer.alarm());
      assert.ok(newer > older, moment);
      const job = await runtime.job();
      assert.equal(job?.generation, newer, moment);
      assert.equal(job?.bulkOperationId, newerOperationId, moment);
      assert.equal((await runtime.importer.status())?.phase, "queued");
      assert.equal(
        (await loadBackfillContext(runtime.kv, shop, newer))?.bulkOperationId,
        newerOperationId,
        moment,
      );
      assert.equal(runtime.kv.entries.has(contextKey(older)), false, moment);
    }
  });

  it("drops a context whose generation was retired while it was stored", async () => {
    const { kv, imports, importer, job } = importerRuntime();
    const generation = (await imports.begin()) as number;
    const put = kv.put;
    kv.put = async (key: string, value: string) => {
      await put(key, value);
      // Disconnect commits between the credential copy and the job.
      await importer.stop();
    };
    assert.equal(await imports.queue(generation, context()), false);
    assert.equal(kv.entries.has(contextKey(generation)), false);
    assert.equal(await job(), undefined);
    await importer.start(bulkOperationId);
    assert.equal(await job(), undefined);
  });

  it("resends a batch whose checkpoint was lost with its original key", async () => {
    const runtime = importerRuntime(shopify({ products: 150 }));
    await runtime.admitted();
    let interrupted = false;
    // The instance is reset before it checkpoints the first batch.
    const reset = async () => {
      runtime.storage.before = reset;
      throw new Error("Durable Object reset");
    };
    const { batches, fetcher } = network(catalog(150), {
      onBatch: async () => {
        if (!interrupted) runtime.storage.before = reset;
        interrupted = true;
        return undefined;
      },
    });
    await withFetch(fetcher, async () => {
      await assert.rejects(runtime.importer.alarm(), /reset/);
      runtime.storage.before = null;
      runtime.evict();
      await runtime.importer.alarm();
    });
    assert.deepEqual(
      batches.map(({ key }) => key),
      [
        "shopify-backfill-321-put-0",
        "shopify-backfill-321-put-0",
        "shopify-backfill-321-put-1",
      ],
    );
    assert.equal((await runtime.importer.status())?.phase, "submitted");
  });
});
