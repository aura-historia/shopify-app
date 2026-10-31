import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  BACKFILL_CONTEXT_TTL_SECONDS,
  type BackfillContext,
  buildBulkProductsQuery,
  CATALOG_EXPORT_WINDOW_MS,
  CATALOG_IMPORT_WINDOW_MS,
  CATALOG_SETUP_CONTEXT_TTL_SECONDS,
  CATALOG_SETUP_RETRY_MS,
  CATALOG_SETUP_WINDOW_MS,
  type CatalogImportJob,
  type CatalogSetupContext,
  type CatalogSetupJob,
  catalogSetupDelay,
  EXPORT_PLAN_VERSION,
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
import {
  boundChannel,
  channelResponse,
  isChannelQuery,
} from "./helpers/channel-fixtures";

const { CATALOG_EXPORT_POLL_MS, CATALOG_MAX_ATTEMPTS } = await import(
  "../workers/catalog-importer"
);

const shop = "importer.myshopify.com";
const bulkOperationId = "gid://shopify/BulkOperation/321";
const newerOperationId = "gid://shopify/BulkOperation/654";
const publicationId = "gid://shopify/Publication/654";
const resultUrl = "https://cdn.shopify.com/importer.jsonl";
const contextKey = (generation: number) =>
  `aura-historia:backfill:${shop}:${generation}`;
// The credentials of a generation awaiting its channel publication.
const setupKey = (generation: number) =>
  `aura-historia:backfill-setup:${shop}:${generation}`;

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

// Shopify reads of the importer. `exportStatus` is the bulk operation's
// status on each read; it throws to fail that read.
function shopify({
  fail = false,
  publicationFailures = 0,
  products = 1,
  exportStatus = (): string => "COMPLETED",
} = {}) {
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
    if (query.includes("bulkOperationCancel"))
      return { data: { bulkOperationCancel: { userErrors: [] } } };
    return {
      data: {
        node: {
          status: exportStatus(),
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
    graphql,
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
    // Serves the download instead, for example a range of it.
    download = (_request: Request) => undefined as Response | undefined,
  } = {},
) {
  const batches: AuraRequest[] = [];
  const fetcher = mock.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === resultUrl) {
        await onDownload();
        const served = download(request);
        if (served) return served;
        // An unranged response reports the export's size.
        return new Response(products, {
          headers: {
            "Content-Length": String(new TextEncoder().encode(products).length),
          },
        });
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

describe("catalog import retries", () => {
  it("restarts its retries after a step that moved on, however often downloads fail", async () => {
    const runtime = importerRuntime(shopify({ products: 450 }));
    await runtime.admitted();
    const products = catalog(450);
    const bytes = new TextEncoder().encode(products);
    // Every download fails a tenth of a segment after its first segment.
    const cut = Math.ceil((bytes.length / 4.5) * 1.1);
    const { batches, fetcher } = network(products, {
      download: (request) => {
        const start = Number(
          /^bytes=(\d+)-$/.exec(request.headers.get("Range") ?? "")?.[1],
        );
        const end = Math.min(start + cut, bytes.length);
        let sent = false;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) controller.enqueue(bytes.slice(start, end));
            else if (end < bytes.length)
              controller.error(new TypeError("terminated"));
            else controller.close();
            sent = true;
          },
        });
        return new Response(body, {
          status: 206,
          headers: {
            "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
          },
        });
      },
    });
    const error = mock.method(console, "error", () => {});
    const attempts: number[] = [];
    try {
      await withFetch(fetcher, async () => {
        for (let alarm = 0; alarm < 10 && (await runtime.job()); alarm++) {
          await runtime.importer.alarm();
          attempts.push((await runtime.job())?.attempts ?? 0);
        }
      });
    } finally {
      error.mock.restore();
    }
    // More failed steps than the retry limit, each after progress.
    assert.deepEqual(attempts, [1, 1, 1, 1, 0]);
    assert.equal((await runtime.importer.status())?.phase, "submitted");
    assert.deepEqual(
      batches.map(({ key }) => key),
      [0, 1, 2, 3, 4].map((index) => `shopify-backfill-321-put-${index}`),
    );
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
    // A delayed completion of the older export admits nothing; only the
    // newer export's next check is armed.
    await runtime.importer.start(bulkOperationId);
    assert.ok((runtime.storage.alarm ?? 0) > Date.now() + 60_000);
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
    assert.ok((storage.alarm ?? 0) > Date.now() + 60_000);
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

describe("catalog import lifetime", () => {
  // `new Date()` and `Date.now()` advance only with the mocked clock.
  beforeEach(() => mock.timers.enable({ apis: ["Date"], now: Date.now() }));
  afterEach(() => mock.timers.reset());

  async function queued(graphql = shopify()) {
    const runtime = importerRuntime(graphql);
    const generation = (await runtime.imports.begin()) as number;
    assert.equal(await runtime.imports.queue(generation, context()), true);
    return { ...runtime, generation, queuedAt: Date.now() };
  }

  it("keeps the context for the export and import windows, released when the import ends", async () => {
    const runtime = await queued();
    assert.equal(
      runtime.kv.ttls.get(contextKey(runtime.generation)),
      BACKFILL_CONTEXT_TTL_SECONDS,
    );
    assert.ok(
      BACKFILL_CONTEXT_TTL_SECONDS * 1000 >
        CATALOG_EXPORT_WINDOW_MS + CATALOG_IMPORT_WINDOW_MS,
    );
    // Shopify exported for longer than a day less a minute, and the import
    // ran almost a day after that: the context is still there.
    mock.timers.tick(CATALOG_EXPORT_WINDOW_MS - 60_000);
    await runtime.importer.start(bulkOperationId);
    mock.timers.tick(CATALOG_IMPORT_WINDOW_MS - 60_000);
    const { batches, fetcher } = network();
    await withFetch(fetcher, () => runtime.importer.alarm());
    assert.equal(batches.length, 1);
    assert.equal((await runtime.importer.status())?.phase, "submitted");
    assert.equal(runtime.kv.entries.has(contextKey(runtime.generation)), false);
  });

  it("never keeps a context beyond its TTL, even if its release failed", async () => {
    const runtime = await queued();
    const key = contextKey(runtime.generation);
    mock.timers.tick(BACKFILL_CONTEXT_TTL_SECONDS * 1000 - 1);
    assert.ok(await runtime.kv.get(key));
    mock.timers.tick(1);
    assert.equal(await runtime.kv.get(key), null);
  });

  it("keeps a Shopify export queued past one hour and imports it when it completes", async () => {
    let state = "RUNNING";
    const runtime = await queued(shopify({ exportStatus: () => state }));
    assert.equal(
      runtime.storage.alarm,
      runtime.queuedAt + CATALOG_EXPORT_POLL_MS,
    );
    // Two hours of export: every check keeps the import queued and current.
    for (let check = 0; check < 24; check++) {
      mock.timers.tick(CATALOG_EXPORT_POLL_MS);
      await runtime.importer.alarm();
      assert.equal(runtime.storage.alarm, Date.now() + CATALOG_EXPORT_POLL_MS);
    }
    assert.equal(Date.now() - runtime.queuedAt, 2 * 3600_000);
    assert.equal((await runtime.importer.status())?.phase, "queued");
    assert.equal((await runtime.job())?.admitted, false);
    assert.ok(runtime.kv.entries.has(contextKey(runtime.generation)));
    state = "COMPLETED";
    await runtime.importer.start(bulkOperationId);
    // The admitted import runs past the hour as well.
    mock.timers.tick(3600_000);
    const { batches, fetcher } = network();
    await withFetch(fetcher, () => runtime.importer.alarm());
    assert.deepEqual(
      batches.map(({ key }) => key),
      ["shopify-backfill-321-put-0"],
    );
    assert.equal((await runtime.importer.status())?.phase, "submitted");
    assert.equal(runtime.kv.entries.has(contextKey(runtime.generation)), false);
  });

  it("admits a completed export whose webhook was lost", async () => {
    const runtime = await queued();
    mock.timers.tick(CATALOG_EXPORT_POLL_MS);
    await runtime.importer.alarm();
    const job = (await runtime.job()) as CatalogImportJob;
    assert.equal(job.admitted, true);
    assert.equal(job.admittedAt, Date.now());
    assert.equal(runtime.storage.alarm, Date.now());
    const { batches, fetcher } = network();
    await withFetch(fetcher, () => runtime.importer.alarm());
    assert.equal(batches.length, 1);
    assert.equal((await runtime.importer.status())?.phase, "submitted");
  });

  it("ends the import when Shopify reports the export failed", async () => {
    const runtime = await queued(shopify({ exportStatus: () => "CANCELED" }));
    mock.timers.tick(CATALOG_EXPORT_POLL_MS);
    await runtime.importer.alarm();
    assert.equal(await runtime.job(), undefined);
    assert.equal(runtime.storage.alarm, null);
    assert.equal(
      (await runtime.importer.status())?.error,
      "SHOPIFY_READ_FAILED",
    );
    assert.equal(runtime.kv.entries.has(contextKey(runtime.generation)), false);
  });

  it("keeps checking an export Shopify cannot report on without claiming it is queued", async () => {
    let readable = false;
    const runtime = await queued(
      shopify({
        exportStatus: () => {
          if (!readable) throw new Error("Throttled");
          return "RUNNING";
        },
      }),
    );
    const warn = mock.method(console, "warn", () => {});
    try {
      // More than an hour of failed checks.
      for (let check = 0; check < 13; check++) {
        mock.timers.tick(CATALOG_EXPORT_POLL_MS);
        await runtime.importer.alarm();
        assert.equal(
          runtime.storage.alarm,
          Date.now() + CATALOG_EXPORT_POLL_MS,
        );
      }
    } finally {
      warn.mock.restore();
    }
    assert.equal(warn.mock.callCount(), 13);
    // The unverified status reads as failed, while the import keeps waiting.
    assert.equal((await runtime.importer.status())?.phase, "failed");
    assert.equal((await runtime.job())?.admitted, false);
    assert.ok(runtime.kv.entries.has(contextKey(runtime.generation)));
    readable = true;
    mock.timers.tick(CATALOG_EXPORT_POLL_MS);
    await runtime.importer.alarm();
    assert.equal((await runtime.importer.status())?.phase, "queued");
  });

  it("ends an export that did not finish within its window", async () => {
    let reads = 0;
    const runtime = await queued(
      shopify({
        exportStatus: () => {
          reads++;
          return "RUNNING";
        },
      }),
    );
    // The last check is due when the window closes.
    mock.timers.tick(CATALOG_EXPORT_WINDOW_MS - 60_000);
    await runtime.importer.alarm();
    assert.equal(
      runtime.storage.alarm,
      runtime.queuedAt + CATALOG_EXPORT_WINDOW_MS,
    );
    mock.timers.tick(60_000);
    await runtime.importer.alarm();
    // The export was checked once more when the window closed.
    assert.equal(reads, 2);
    const status = await runtime.importer.status();
    assert.equal(status?.phase, "failed");
    assert.equal(status?.error, "EXPORT_EXPIRED");
    assert.equal(await runtime.job(), undefined);
    assert.equal(runtime.storage.alarm, null);
    assert.equal(runtime.kv.entries.has(contextKey(runtime.generation)), false);
    // Shopify's export is cancelled, so it holds no bulk capacity.
    const graphql = runtime.graphql;
    const cancels = graphql.mock.calls.filter(({ arguments: [query] }) =>
      query.includes("bulkOperationCancel"),
    );
    assert.deepEqual(
      cancels.map(({ arguments: [, variables] }) => variables),
      [{ id: bulkOperationId }],
    );
    // A late completion admits nothing.
    await runtime.importer.start(bulkOperationId);
    assert.equal(runtime.storage.alarm, null);
  });

  it("admits an export Shopify completed just before its window closed", async () => {
    let state = "RUNNING";
    const runtime = await queued(shopify({ exportStatus: () => state }));
    mock.timers.tick(CATALOG_EXPORT_WINDOW_MS - 60_000);
    await runtime.importer.alarm();
    // It completes before the last check, and its webhook is lost.
    state = "COMPLETED";
    mock.timers.tick(60_000);
    await runtime.importer.alarm();
    assert.equal((await runtime.job())?.admitted, true);
    const { batches, fetcher } = network();
    await withFetch(fetcher, () => runtime.importer.alarm());
    assert.equal(batches.length, 1);
    assert.equal((await runtime.importer.status())?.phase, "submitted");
  });

  it("admits a completion delivered up to one check after the window, and refuses a later one", async () => {
    for (const [late, admitted] of [
      [CATALOG_EXPORT_POLL_MS - 1, true],
      [CATALOG_EXPORT_POLL_MS, false],
    ] as const) {
      const runtime = await queued();
      // The alarm was lost.
      runtime.storage.alarm = null;
      mock.timers.tick(CATALOG_EXPORT_WINDOW_MS + late);
      await runtime.importer.start(bulkOperationId);
      assert.equal(
        (await runtime.job())?.admitted,
        admitted ? true : undefined,
      );
      assert.equal(
        (await runtime.importer.status())?.error,
        admitted ? undefined : "EXPORT_EXPIRED",
      );
      assert.equal(
        runtime.kv.entries.has(contextKey(runtime.generation)),
        admitted,
      );
    }
  });

  it("ends an import that outlived its window and reports its progress", async () => {
    const runtime = await queued();
    await runtime.importer.start(bulkOperationId);
    const job = (await runtime.job()) as CatalogImportJob;
    await runtime.storage.put("job", {
      ...job,
      offset: 4096,
      cursor: 1,
      total: 100,
      eligible: 90,
      withdrawn: 10,
      rejected: 1,
    });
    mock.timers.tick(CATALOG_IMPORT_WINDOW_MS);
    const { batches, fetcher } = network();
    await withFetch(fetcher, () => runtime.importer.alarm());
    assert.equal(fetcher.mock.callCount(), 0);
    assert.deepEqual(batches, []);
    const status = await runtime.importer.status();
    assert.deepEqual(
      { ...status, updatedAt: undefined },
      {
        phase: "failed",
        total: 100,
        eligible: 90,
        withdrawn: 10,
        failed: 1,
        error: "IMPORT_EXPIRED",
        updatedAt: undefined,
      },
    );
    assert.equal(await runtime.job(), undefined);
    assert.equal(runtime.kv.entries.has(contextKey(runtime.generation)), false);
  });

  it("never resumes an import planned under other segment rules", async () => {
    // Before streamed exports, or under another plan version.
    for (const plan of [undefined, EXPORT_PLAN_VERSION + 1]) {
      const runtime = importerRuntime();
      const generation = await runtime.admitted();
      const legacy = { ...((await runtime.job()) as CatalogImportJob), plan };
      await runtime.storage.put("job", legacy);
      const { fetcher } = network();
      await withFetch(fetcher, () => runtime.importer.alarm());
      assert.equal(fetcher.mock.callCount(), 0);
      assert.equal(await runtime.job(), undefined);
      assert.equal(
        (await runtime.importer.status())?.error,
        "INCOMPLETE_EXPORT",
      );
      assert.equal(runtime.kv.entries.has(contextKey(generation)), false);
      // An unadmitted one is never admitted.
      await runtime.storage.put("job", { ...legacy, admitted: false });
      await runtime.importer.start(bulkOperationId);
      assert.equal(
        (await runtime.storage.get<CatalogImportJob>("job"))?.admitted,
        false,
      );
    }
  });
});

describe("catalog import setup", () => {
  // `new Date()` and `Date.now()` advance only with the mocked clock.
  beforeEach(() => mock.timers.enable({ apis: ["Date"], now: Date.now() }));
  afterEach(() => mock.timers.reset());

  const setupContext = (): CatalogSetupContext => {
    const {
      bulkOperationId: _operation,
      publicationId: _publication,
      createdAt: _created,
      ...setup
    } = context({ primaryLocale: "de" });
    return setup;
  };

  // Shopify right after the channel connection was set up: its app catalog
  // and publication are returned only once `publication` is set. `onRead`
  // runs while the publication is read, `onSubmit` while the export is
  // submitted.
  function settingUp(
    state: {
      publication?: unknown;
      listed?: boolean;
      scopes?: string[];
      channel?: unknown;
      submission?: unknown;
    } = {},
  ) {
    const shopify = {
      publication: null as unknown,
      listed: false,
      scopes: ["read_product_listings", "read_publications"],
      channel: boundChannel(),
      submission: null as unknown,
      onRead: async () => {},
      onSubmit: async () => {},
      // The bulk queries Shopify was asked to export, and the exports it was
      // asked to cancel.
      exports: [] as string[],
      cancels: [] as unknown[],
      ...state,
    };
    const graphql = mock.fn(
      async (query: string, variables: Record<string, unknown>) => {
        if (query.includes("AuraChannelCatalogs")) await shopify.onRead();
        if (isChannelQuery(query))
          return channelResponse(
            query,
            {
              scopes: shopify.scopes,
              channel: shopify.channel,
              publication: shopify.publication,
              listed: shopify.listed || shopify.publication !== null,
            },
            variables,
          );
        if (query.includes("bulkOperationCancel")) {
          shopify.cancels.push(variables.id);
          return { data: { bulkOperationCancel: { userErrors: [] } } };
        }
        if (query.includes("bulkOperationRunQuery")) {
          shopify.exports.push(String(variables.query));
          await shopify.onSubmit();
          return (
            shopify.submission ?? {
              data: {
                bulkOperationRunQuery: {
                  bulkOperation: { id: bulkOperationId, status: "CREATED" },
                  userErrors: [],
                },
              },
            }
          );
        }
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
      },
    );
    return { shopify, graphql };
  }

  // An import whose channel connection was set up, but whose publication
  // Shopify did not return when it began.
  async function waiting(state: Parameters<typeof settingUp>[0] = {}) {
    const { shopify, graphql } = settingUp(state);
    const runtime = importerRuntime(graphql);
    const generation = (await runtime.imports.begin()) as number;
    assert.equal(
      await runtime.imports.awaitPublication(generation, setupContext()),
      true,
    );
    // Its credentials wait in their own short-lived context.
    assert.equal(
      runtime.kv.ttls.get(setupKey(generation)),
      CATALOG_SETUP_CONTEXT_TTL_SECONDS,
    );
    assert.equal(runtime.kv.entries.has(contextKey(generation)), false);
    return {
      ...runtime,
      shopify,
      generation,
      since: Date.now(),
      setup: () => runtime.storage.get<CatalogSetupJob>("setup"),
      // Runs the importer's alarm at the time it is due.
      async due() {
        const alarm = runtime.storage.alarm;
        assert.ok(alarm !== null, "an alarm is due");
        mock.timers.tick(Math.max(0, alarm - Date.now()));
        await runtime.importer.alarm();
      },
    };
  }

  it("exports the channel's selection once Shopify returns its publication", async () => {
    const runtime = await waiting();
    assert.equal(runtime.storage.alarm, runtime.since + CATALOG_SETUP_RETRY_MS);
    const status = await runtime.importer.status();
    assert.equal(status?.phase, "queued");
    assert.equal(status?.awaiting, "CHANNEL_PUBLICATION");
    assert.equal(await runtime.job(), undefined);
    // Still no catalog for the new connection: nothing is exported.
    await runtime.due();
    assert.deepEqual(runtime.shopify.exports, []);
    assert.equal((await runtime.setup())?.checks, 1);
    assert.equal(runtime.storage.alarm, Date.now() + catalogSetupDelay(1));
    // Then the catalog lists the connection without a publication, and a
    // read fails: the import keeps waiting.
    runtime.shopify.listed = true;
    await runtime.due();
    runtime.shopify.publication = new Error("Throttled");
    const warn = mock.method(console, "warn", () => {});
    try {
      await runtime.due();
    } finally {
      warn.mock.restore();
    }
    assert.deepEqual(runtime.shopify.exports, []);
    assert.equal((await runtime.setup())?.checks, 3);
    assert.equal(
      (await runtime.importer.status())?.awaiting,
      "CHANNEL_PUBLICATION",
    );
    // Shopify returns the catalog's publication.
    runtime.shopify.publication = { id: publicationId };
    await runtime.due();
    assert.deepEqual(runtime.shopify.exports, [
      buildBulkProductsQuery(publicationId),
    ]);
    assert.equal(await runtime.setup(), undefined);
    const job = (await runtime.job()) as CatalogImportJob;
    assert.equal(job.generation, runtime.generation);
    assert.equal(job.bulkOperationId, bulkOperationId);
    assert.equal(job.admitted, false);
    assert.equal(runtime.storage.alarm, Date.now() + CATALOG_EXPORT_POLL_MS);
    const queued = await runtime.importer.status();
    assert.equal(queued?.phase, "queued");
    assert.equal(queued?.awaiting, undefined);
    // The export's context is written, and the setup context released.
    assert.equal(runtime.kv.entries.has(setupKey(runtime.generation)), false);
    const stored = await loadBackfillContext(
      runtime.kv,
      shop,
      runtime.generation,
    );
    assert.equal(stored?.publicationId, publicationId);
    assert.equal(stored?.bulkOperationId, bulkOperationId);
    assert.equal(stored?.accessToken, "aura-private-token");
    assert.equal(stored?.primaryLocale, "de");
    assert.equal(
      runtime.kv.ttls.get(contextKey(runtime.generation)),
      BACKFILL_CONTEXT_TTL_SECONDS,
    );
    // The import then runs as any other.
    await runtime.importer.start(bulkOperationId);
    const { batches, fetcher } = network();
    await withFetch(fetcher, () => runtime.importer.alarm());
    assert.deepEqual(
      batches.map(({ key }) => key),
      ["shopify-backfill-321-put-0"],
    );
    assert.equal((await runtime.importer.status())?.phase, "submitted");
    assert.equal(runtime.kv.entries.has(contextKey(runtime.generation)), false);
  });

  it("reports what Shopify last returned once the setup window closed", async () => {
    for (const [state, error] of [
      [{ publication: null }, "MISSING_PUBLICATION"],
      [{ publication: null, listed: true }, "MISSING_PUBLICATION"],
      // Reads that keep failing during the wait.
      [
        { publication: { id: "gid://shopify/Channel/1" } },
        "SHOPIFY_READ_FAILED",
      ],
    ] satisfies [Parameters<typeof waiting>[0], string][]) {
      const runtime = await waiting(state);
      const checks: number[] = [];
      const warn = mock.method(console, "warn", () => {});
      try {
        // Bounded: a wait that never ends fails here instead of hanging.
        for (
          let check = 0;
          check < 50 && runtime.storage.alarm !== null;
          check++
        ) {
          checks.push(runtime.storage.alarm - Date.now());
          await runtime.due();
        }
      } finally {
        warn.mock.restore();
      }
      // Waits double from 2 seconds to a minute, and the last check is due
      // when the window closes.
      assert.deepEqual(
        checks.slice(0, 7),
        [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000],
      );
      assert.equal(Date.now(), runtime.since + CATALOG_SETUP_WINDOW_MS);
      assert.ok(checks.length <= 16, String(checks.length));
      assert.deepEqual(runtime.shopify.exports, []);
      const status = await runtime.importer.status();
      assert.equal(status?.phase, "failed", error);
      assert.equal(status?.error, error);
      assert.equal(status?.awaiting, undefined);
      assert.equal(await runtime.setup(), undefined);
      assert.equal(await runtime.job(), undefined);
      assert.equal(runtime.kv.entries.has(setupKey(runtime.generation)), false);
    }
  });

  it("ends the wait at once on missing access or a missing or foreign connection", async () => {
    for (const [state, error] of [
      [{ scopes: ["read_product_listings"] }, "MISSING_SCOPE"],
      [{ channel: null }, "MISSING_CHANNEL"],
      [
        { channel: boundChannel({ accountId: `ls_${"1".repeat(26)}` }) },
        "MISSING_CHANNEL",
      ],
    ] satisfies [Parameters<typeof waiting>[0], string][]) {
      const runtime = await waiting(state);
      const warn = mock.method(console, "warn", () => {});
      try {
        await runtime.due();
      } finally {
        warn.mock.restore();
      }
      assert.deepEqual(runtime.shopify.exports, []);
      assert.equal((await runtime.importer.status())?.error, error);
      assert.equal(await runtime.setup(), undefined);
      assert.equal(runtime.storage.alarm, null);
      assert.equal(runtime.kv.entries.has(setupKey(runtime.generation)), false);
    }
  });

  it("reports a failed export submission instead of retrying it", async () => {
    const runtime = await waiting({
      publication: { id: publicationId },
      submission: { errors: [{ message: "Too many bulk operations" }] },
    });
    const error = mock.method(console, "error", () => {});
    try {
      await runtime.due();
    } finally {
      error.mock.restore();
    }
    assert.equal(runtime.shopify.exports.length, 1);
    assert.equal(
      (await runtime.importer.status())?.error,
      "SHOPIFY_READ_FAILED",
    );
    assert.equal(await runtime.setup(), undefined);
    assert.equal(await runtime.job(), undefined);
    assert.equal(runtime.storage.alarm, null);
    assert.equal(runtime.kv.entries.has(setupKey(runtime.generation)), false);
  });

  it("awaits a missing context like a failed read and never exports without it", async () => {
    const runtime = await waiting({ publication: { id: publicationId } });
    runtime.kv.entries.delete(setupKey(runtime.generation));
    const warn = mock.method(console, "warn", () => {});
    try {
      await runtime.due();
      assert.equal((await runtime.setup())?.checks, 1);
      for (let check = 0; check < 50 && runtime.storage.alarm !== null; check++)
        await runtime.due();
      assert.equal(runtime.storage.alarm, null);
    } finally {
      warn.mock.restore();
    }
    assert.deepEqual(runtime.shopify.exports, []);
    assert.equal(
      (await runtime.importer.status())?.error,
      "SHOPIFY_READ_FAILED",
    );
  });

  it("checks again as soon as its status is read when its alarm was lost", async () => {
    const runtime = await waiting({ publication: { id: publicationId } });
    // For example, the runtime gave up retrying a failed alarm.
    runtime.storage.alarm = null;
    assert.equal(
      (await runtime.importer.status())?.awaiting,
      "CHANNEL_PUBLICATION",
    );
    assert.equal(runtime.storage.alarm, Date.now());
    await runtime.due();
    assert.equal(runtime.shopify.exports.length, 1);
    assert.equal((await runtime.job())?.generation, runtime.generation);
    // Reading the status re-arms nothing else.
    const alarm = runtime.storage.alarm;
    await runtime.importer.status();
    assert.equal(runtime.storage.alarm, alarm);
  });

  it("stops waiting on disconnect, uninstall or replacement", async () => {
    for (const stop of ["stop", "newer import"] as const) {
      const runtime = await waiting();
      if (stop === "stop") await runtime.importer.stop();
      else await runtime.imports.begin();
      assert.equal(await runtime.setup(), undefined, stop);
      assert.equal(runtime.storage.alarm, null, stop);
      assert.equal(
        runtime.kv.entries.has(setupKey(runtime.generation)),
        false,
        stop,
      );
      assert.equal(
        (await runtime.importer.status())?.phase,
        stop === "stop" ? undefined : "queued",
      );
      // A late alarm or a retired generation's writes revive nothing, even
      // once Shopify returns the publication.
      runtime.shopify.publication = { id: publicationId };
      await runtime.importer.alarm();
      assert.equal(
        await runtime.imports.awaitPublication(
          runtime.generation,
          setupContext(),
        ),
        false,
      );
      assert.equal(
        await runtime.importer.fail(runtime.generation, "MISSING_PUBLICATION"),
        false,
      );
      assert.deepEqual(runtime.shopify.exports, [], stop);
      assert.equal(await runtime.setup(), undefined, stop);
      assert.equal(await runtime.job(), undefined, stop);
      assert.equal(
        runtime.kv.entries.has(setupKey(runtime.generation)),
        false,
        stop,
      );
    }
  });

  it("exports nothing for a wait retired while the publication was read", async () => {
    const runtime = await waiting({ publication: { id: publicationId } });
    runtime.shopify.onRead = async () => {
      runtime.shopify.onRead = async () => {};
      await runtime.importer.stop();
    };
    await runtime.due();
    assert.deepEqual(runtime.shopify.exports, []);
    assert.equal(await runtime.job(), undefined);
    assert.equal(runtime.storage.alarm, null);
    assert.equal(await runtime.importer.status(), null);
  });

  it("discards an export whose wait was retired while it was submitted", async () => {
    const runtime = await waiting({ publication: { id: publicationId } });
    let newer = 0;
    // "Import catalog again" begins while Shopify accepts the export.
    runtime.shopify.onSubmit = async () => {
      newer = (await runtime.imports.begin()) as number;
    };
    const warn = mock.method(console, "warn", () => {});
    try {
      await runtime.due();
    } finally {
      warn.mock.restore();
    }
    assert.ok(newer > runtime.generation);
    // The export was never recorded and is cancelled; its completion admits
    // nothing.
    assert.deepEqual(runtime.shopify.cancels, [bulkOperationId]);
    assert.equal(await runtime.job(), undefined);
    assert.equal(runtime.kv.entries.has(contextKey(runtime.generation)), false);
    assert.equal(runtime.kv.entries.has(setupKey(runtime.generation)), false);
    await runtime.importer.start(bulkOperationId);
    assert.equal(runtime.storage.alarm, null);
    assert.equal((await runtime.importer.status())?.phase, "queued");
    assert.equal(await runtime.storage.get("generation"), newer);
  });
});
