import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, mock } from "node:test";
import {
  BACKFILL_CONTEXT_TTL_SECONDS,
  type BackfillContext,
  type BulkJsonlProduct,
  buildBulkProductsQuery,
  buildShopifyIngestionConfiguration,
  CATALOG_EXPORT_WINDOW_MS,
  CATALOG_IMPORT_WINDOW_MS,
  type CatalogImportJob,
  cancelBulkOperation,
  classifyShopifyBackfillAction,
  clearBackfillContext,
  configureShopifyListingSource,
  createBackfillIdempotencyKey,
  EXPORT_PLAN_VERSION,
  EXPORT_READ_TIMEOUT_MS,
  ExportCapacityError,
  ExportLines,
  type ExportSegment,
  ExportSegments,
  extractShopifyNumericId,
  fetchBulkOperationResult,
  fetchShopMetadata,
  type GraphqlRequestFn,
  loadBackfillContext,
  MAX_EXPORT_BYTES,
  MAX_EXPORT_LINE_BYTES,
  MAX_EXPORT_PRODUCTS,
  MalformedExportError,
  mapShopifyCurrencyCode,
  mapShopifyLocaleToLanguage,
  normalizeShopifyDomain,
  openBackfillExport,
  planSegment,
  putShopifyIngestionConfiguration,
  readBulkOperationState,
  requireSupportedShopifyCurrency,
  resolveLanguage,
  resumeCatalogImport,
  runCatalogImportStep,
  SEGMENT_BYTES,
  sendProductBatch,
  storeBackfillContext,
  submitBulkOperation,
  transformProduct,
  transformWithdrawal,
  triggerBackfill,
  type ValidatedShopifyMetadata,
} from "../app/backfill.server";
import type { CatalogImportStatus } from "../app/catalog.server";
import {
  createImporter,
  ImporterStorage,
  importsOf,
} from "./helpers/catalog-importer";
import {
  boundChannel,
  type ChannelState,
  channelResponse,
  isChannelQuery,
} from "./helpers/channel-fixtures";

const listingSourceId = `ls_${"0".repeat(26)}`;
const apiBaseUrl = "https://api.test.com";
const shopDomain = "my-shop.myshopify.com";
const accessToken = "aurahistoria_accesstoken_test";
const bulkOperationId = "gid://shopify/BulkOperation/789";
const publicationId = "gid://shopify/Publication/456";

function makeProduct(
  overrides: Partial<BulkJsonlProduct> = {},
): BulkJsonlProduct {
  return {
    id: "gid://shopify/Product/12345",
    title: "Antique Clock",
    status: "ACTIVE",
    totalInventory: 5,
    tracksInventory: true,
    onlineStoreUrl: `https://${shopDomain}/products/antique-clock`,
    handle: "antique-clock",
    publishedOnPublication: true,
    ...overrides,
  };
}

function makeContext(
  overrides: Partial<BackfillContext> = {},
): BackfillContext {
  return {
    listingSourceId,
    accessToken,
    apiBaseUrl,
    primaryLocale: "de",
    currencyCode: "EUR",
    shopDomain,
    bulkOperationId,
    publicationId,
    createdAt: "2026-06-06T00:00:00.000Z",
    ...overrides,
  };
}

function makeKv() {
  const entries = new Map<string, string>();
  return {
    get: mock.fn(async (key: string) => entries.get(key) ?? null),
    put: mock.fn(
      async (
        key: string,
        value: string,
        _opts?: { expirationTtl?: number },
      ) => {
        entries.set(key, value);
      },
    ),
    delete: mock.fn(async (key: string) => {
      entries.delete(key);
    }),
    entries,
  };
}

// The shop's actual catalog importer on isolated storage. Imports begin
// directly, as the coordinator begins them for its bound connection.
function catalogImports() {
  const kv = makeKv();
  const storage = new ImporterStorage();
  const importer = createImporter(storage, { KV: kv } as never);
  return {
    kv,
    storage,
    importer,
    imports: importsOf(importer, shopDomain),
    job: () => storage.get<CatalogImportJob>("job"),
    // The context of the queued export.
    async context() {
      const job = await storage.get<CatalogImportJob>("job");
      return job ? loadBackfillContext(kv, shopDomain, job.generation) : null;
    },
  };
}

function report(
  acceptedCount: number,
  failures: Array<{
    index: number;
    sourceListingId?: string;
    error: string;
    retryable: boolean;
  }> = [],
) {
  return { submissionId: "submission-1", acceptedCount, failures };
}

function jsonResponse(value: unknown, status = 202): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function asRequest(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

function withFetch(
  fetcher: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

const bytesOf = (text: string) => new TextEncoder().encode(text);

// The export as a stream of `size`-byte chunks.
function exportStream(content: string | Uint8Array, size = 64 * 1024) {
  const bytes = typeof content === "string" ? bytesOf(content) : content;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += size)
        controller.enqueue(bytes.slice(i, i + size));
      controller.close();
    },
  });
}

// Every segment of an export read from `offset`, in `chunk`-byte chunks.
async function readSegments(
  content: string | Uint8Array,
  {
    chunk = 64 * 1024,
    offset = 0,
    size = null as number | null,
    limit = MAX_EXPORT_BYTES,
  } = {},
) {
  const bytes = typeof content === "string" ? bytesOf(content) : content;
  const segments = new ExportSegments(
    new ExportLines(
      exportStream(bytes.subarray(offset), chunk).getReader(),
      offset,
      { size, limit },
    ),
  );
  const all: ExportSegment[] = [];
  for (
    let segment = await segments.next();
    segment;
    segment = await segments.next()
  )
    all.push(segment);
  return all;
}

describe("Shopify IDs, locale, currency and domain", () => {
  it("extracts numeric IDs from Shopify GIDs and plain IDs", () => {
    assert.equal(
      extractShopifyNumericId("gid://shopify/Product/12345"),
      "12345",
    );
    assert.equal(extractShopifyNumericId("99999"), "99999");
  });

  it("maps supported regional locales without silently defaulting configuration", () => {
    assert.equal(mapShopifyLocaleToLanguage("de-AT"), "de");
    assert.equal(mapShopifyLocaleToLanguage("pt-BR"), "pt");
    assert.equal(mapShopifyLocaleToLanguage("ja"), "ja");
    assert.equal(mapShopifyLocaleToLanguage("sv-SE"), undefined);
    assert.equal(mapShopifyLocaleToLanguage(undefined), undefined);
    assert.equal(resolveLanguage("sv-SE"), "en");
  });

  it("accepts supported currencies and normalizes the shop domain", () => {
    assert.equal(mapShopifyCurrencyCode("JPY"), "JPY");
    assert.equal(mapShopifyCurrencyCode("EUR"), "EUR");
    assert.equal(mapShopifyCurrencyCode("SEK"), "SEK");
    assert.equal(mapShopifyCurrencyCode("ARS"), "ARS");
    assert.equal(mapShopifyCurrencyCode(undefined), undefined);
    assert.equal(normalizeShopifyDomain(" My-Shop.MyShopify.com "), shopDomain);
    assert.equal(normalizeShopifyDomain("  "), undefined);
  });

  it("requires a supported Shopify currency", () => {
    assert.equal(requireSupportedShopifyCurrency("EUR"), "EUR");
    assert.equal(requireSupportedShopifyCurrency("JPY"), "JPY");
    assert.throws(
      () => requireSupportedShopifyCurrency(undefined),
      /missing Shopify currency/,
    );
    assert.throws(
      () => requireSupportedShopifyCurrency("XXX"),
      /Shopify currency: XXX/,
    );
  });

  it("always configures the normalized domain and required currency, omitting unknown language", () => {
    assert.deepEqual(
      buildShopifyIngestionConfiguration(
        { primaryLocale: "de-AT", currencyCode: "EUR" },
        " My-Shop.MyShopify.com ",
      ),
      { domain: shopDomain, currency: "EUR", language: "de" },
    );
    assert.deepEqual(
      buildShopifyIngestionConfiguration(
        { primaryLocale: "sv-SE", currencyCode: "JPY" },
        shopDomain,
      ),
      { domain: shopDomain, currency: "JPY" },
    );
    assert.throws(
      () =>
        buildShopifyIngestionConfiguration({ currencyCode: "XXX" }, shopDomain),
      /Shopify currency: XXX/,
    );
  });
});

describe("Shopify product transformation", () => {
  it("upserts source listing ID, localized title, URL, images and monetary price", () => {
    const result = transformProduct(
      makeProduct(),
      ["https://cdn.shopify.com/clock.jpg"],
      "29.99",
      "de",
      "EUR",
      shopDomain,
    );
    assert.equal(result.sourceListingId, "12345");
    assert.deepEqual(result.title, { text: "Antique Clock", language: "de" });
    assert.equal(result.url, `https://${shopDomain}/products/antique-clock`);
    assert.deepEqual(result.images, ["https://cdn.shopify.com/clock.jpg"]);
    assert.deepEqual(result.price, {
      type: "MONETARY",
      amount: 2999,
      currency: "EUR",
    });
    assert.equal("description" in result, false);
    assert.equal("state" in result, false);
  });

  it("uses zero-decimal JPY minor units and preserves a zero price", () => {
    assert.deepEqual(
      transformProduct(makeProduct(), [], "1234", "ja", "JPY", shopDomain)
        .price,
      { type: "MONETARY", amount: 1234, currency: "JPY" },
    );
    assert.deepEqual(
      transformProduct(makeProduct(), [], "0.00", "en", "EUR", shopDomain)
        .price,
      { type: "MONETARY", amount: 0, currency: "EUR" },
    );
  });

  it("clears a stale price when Shopify has none or currency is unsupported", () => {
    assert.equal(
      transformProduct(makeProduct(), [], null, "en", "EUR", shopDomain).price,
      null,
    );
    assert.equal(
      transformProduct(makeProduct(), [], "10.00", "en", "XXX", shopDomain)
        .price,
      null,
    );
  });

  it("maps tracked and untracked inventory to availability without legacy states", () => {
    const available = transformProduct(
      makeProduct(),
      [],
      null,
      "en",
      "EUR",
      shopDomain,
    );
    const soldOut = transformProduct(
      makeProduct({ totalInventory: 0 }),
      [],
      null,
      "en",
      "EUR",
      shopDomain,
    );
    const untracked = transformProduct(
      makeProduct({ totalInventory: 10, tracksInventory: false }),
      [],
      null,
      "en",
      "EUR",
      shopDomain,
    );
    assert.equal(available.availability, "IN_STOCK");
    assert.equal(soldOut.availability, "OUT_OF_STOCK");
    assert.equal(untracked.availability, null);
    assert.equal(
      transformProduct(
        makeProduct({ totalInventory: 0, tracksInventory: false }),
        [],
        null,
        "en",
        "EUR",
        shopDomain,
      ).availability,
      null,
    );
  });

  it("uses the product handle for missing onlineStoreUrl and does not invent a numeric product path", () => {
    const result = transformProduct(
      makeProduct({ onlineStoreUrl: null }),
      [],
      null,
      "en",
      "EUR",
      shopDomain,
    );
    assert.equal(result.url, `https://${shopDomain}/products/antique-clock`);
    assert.throws(
      () =>
        transformProduct(
          makeProduct({ onlineStoreUrl: null, handle: "" }),
          [],
          null,
          "en",
          "EUR",
          shopDomain,
        ),
      /Missing storefront URL/,
    );
  });

  it("withdraws an inactive Shopify product using only its source listing ID", () => {
    assert.deepEqual(transformWithdrawal(makeProduct({ status: "ARCHIVED" })), {
      sourceListingId: "12345",
    });
  });
});

describe("Shopify JSONL and KV context", () => {
  it("parses product, image and first variant price without description HTML", async () => {
    const lines = [
      JSON.stringify(makeProduct({ id: "gid://shopify/Product/1" })),
      '{"id":"gid://shopify/ProductImage/10","url":"https://cdn.shopify.com/1.jpg","__parentId":"gid://shopify/Product/1"}',
      '{"id":"gid://shopify/ProductVariant/10","price":"49.99","__parentId":"gid://shopify/Product/1"}',
      '{"id":"gid://shopify/ProductVariant/11","price":"50.00","__parentId":"gid://shopify/Product/1"}',
    ];
    const jsonl = lines.join("\n");
    assert.deepEqual(await readSegments(jsonl), [
      {
        start: 0,
        end: bytesOf(jsonl).length,
        products: [
          {
            product: makeProduct({ id: "gid://shopify/Product/1" }),
            images: ["https://cdn.shopify.com/1.jpg"],
            price: "49.99",
          },
        ],
      },
    ]);
  });

  it("returns no segment for an empty export and no images for a bare product", async () => {
    for (const empty of ["", "\n", "\n\n  \n"])
      assert.deepEqual(await readSegments(empty), []);
    const [segment] = await readSegments(JSON.stringify(makeProduct()));
    assert.deepEqual(segment.products, [
      { product: makeProduct(), images: [], price: null },
    ]);
  });

  it("round-trips the new required context with a TTL and supports clearing", async () => {
    const kv = makeKv();
    const context = makeContext();
    await storeBackfillContext(kv as never, shopDomain, 7, context);
    assert.deepEqual(
      await loadBackfillContext(kv as never, shopDomain, 7),
      context,
    );
    assert.deepEqual(kv.put.mock.calls[0].arguments[2], {
      expirationTtl: BACKFILL_CONTEXT_TTL_SECONDS,
    });
    // The context outlives Shopify's export window and the import window
    // that follows it, by an hour.
    assert.equal(
      BACKFILL_CONTEXT_TTL_SECONDS,
      (CATALOG_EXPORT_WINDOW_MS + CATALOG_IMPORT_WINDOW_MS) / 1000 + 3600,
    );
    assert.equal("shopId" in context, false);
    assert.equal("apiKey" in context, false);
    await clearBackfillContext(kv as never, shopDomain, 7);
    assert.equal(await loadBackfillContext(kv as never, shopDomain, 7), null);
    await storeBackfillContext(
      kv as never,
      shopDomain,
      7,
      makeContext({ primaryLocale: undefined }),
    );
    assert.equal(
      (await loadBackfillContext(kv as never, shopDomain, 7))?.primaryLocale,
      undefined,
    );
  });

  it("keeps each import generation's context under its own key", async () => {
    const kv = makeKv();
    await storeBackfillContext(kv as never, shopDomain, 7, makeContext());
    await storeBackfillContext(
      kv as never,
      shopDomain.toUpperCase(),
      8,
      makeContext({ bulkOperationId: "gid://shopify/BulkOperation/790" }),
    );
    await clearBackfillContext(kv as never, shopDomain, 7);
    assert.deepEqual(
      [...kv.entries.keys()],
      [`aura-historia:backfill:${shopDomain}:8`],
    );
    assert.equal(
      (await loadBackfillContext(kv as never, shopDomain, 8))?.bulkOperationId,
      "gid://shopify/BulkOperation/790",
    );
    for (const generation of [0, -1, 1.5, Number.NaN])
      await assert.rejects(
        loadBackfillContext(kv as never, shopDomain, generation),
        /generation/,
      );
  });

  it("returns null for absent or malformed context", async () => {
    const kv = makeKv();
    const key = `aura-historia:backfill:${shopDomain}:7`;
    const load = () => loadBackfillContext(kv as never, shopDomain, 7);
    assert.equal(await load(), null);
    kv.entries.set(key, "{");
    assert.equal(await load(), null);
    kv.entries.set(
      key,
      JSON.stringify({
        ...makeContext(),
        listingSourceId: undefined,
        shopId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    );
    assert.equal(await load(), null);
    kv.entries.set(
      key,
      JSON.stringify(makeContext({ currencyCode: "XXX" as never })),
    );
    assert.equal(await load(), null);
    // Contexts without the snapshot's publication and time are not applied.
    for (const overrides of [
      { publicationId: undefined },
      { publicationId: "gid://shopify/Channel/1" },
    ]) {
      kv.entries.set(key, JSON.stringify(makeContext(overrides as never)));
      assert.equal(await load(), null);
    }
  });
});

describe("Shopify GraphQL", () => {
  it("fetches locale and currency and retains undefined missing values", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(async () => ({
      data: {
        shopLocales: [{ locale: "de", primary: true }],
        shop: { currencyCode: "EUR" },
      },
    }));
    assert.deepEqual(await fetchShopMetadata(graphqlRequest), {
      primaryLocale: "de",
      currencyCode: "EUR",
    });
    assert.deepEqual(
      await fetchShopMetadata(async () => ({
        data: { shopLocales: [], shop: {} },
      })),
      { primaryLocale: undefined, currencyCode: undefined },
    );
    await assert.rejects(
      () => fetchShopMetadata(async () => ({ errors: "Not Found" })),
      /Not Found/,
    );
  });

  it("submits a grouped bulk query without descriptions and returns the operation ID", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(
      async (mutation, variables) => {
        // Children directly follow their product, so the export streams.
        assert.match(
          mutation,
          /bulkOperationRunQuery\(query: \$query, groupObjects: true\)/,
        );
        const bulkQuery = variables.query;
        assert.equal(typeof bulkQuery, "string");
        assert.match(bulkQuery as string, /handle/);
        assert.match(bulkQuery as string, /totalInventory/);
        assert.match(bulkQuery as string, /tracksInventory/);
        assert.ok(
          (bulkQuery as string).includes(
            `publishedOnPublication(publicationId: "${publicationId}")`,
          ),
        );
        assert.doesNotMatch(bulkQuery as string, /descriptionHtml|description/);
        return {
          data: {
            bulkOperationRunQuery: {
              bulkOperation: { id: bulkOperationId, status: "CREATED" },
              userErrors: [],
            },
          },
        };
      },
    );
    assert.equal(
      await submitBulkOperation(graphqlRequest, publicationId),
      bulkOperationId,
    );
    await assert.rejects(
      () =>
        submitBulkOperation(
          async () => ({
            data: {
              bulkOperationRunQuery: {
                bulkOperation: null,
                userErrors: [{ message: "Already running" }],
              },
            },
          }),
          publicationId,
        ),
      /Already running/,
    );
  });

  it("embeds only a validated publication GID into the bulk query", () => {
    assert.match(
      buildBulkProductsQuery(publicationId),
      /publishedOnPublication\(publicationId: "gid:\/\/shopify\/Publication\/456"\)/,
    );
    for (const id of [
      "",
      "gid://shopify/Publication/0",
      "gid://shopify/Channel/456",
      'gid://shopify/Publication/1") { id } x: products(query: "',
    ]) {
      assert.throws(() => buildBulkProductsQuery(id), /publication ID/);
    }
  });

  it("fetches completed bulk URLs and rejects incomplete operations", async () => {
    const request: GraphqlRequestFn = async (_query, variables) => {
      assert.deepEqual(variables, { id: bulkOperationId });
      return {
        data: {
          node: {
            id: bulkOperationId,
            status: "COMPLETED",
            url: "https://cdn.shopify.com/result.jsonl",
          },
        },
      };
    };
    assert.deepEqual(await fetchBulkOperationResult(request, bulkOperationId), {
      url: "https://cdn.shopify.com/result.jsonl",
      rootObjectCount: null,
      fileSize: null,
    });
    for (const node of [
      null,
      { status: "RUNNING" },
      { status: "COMPLETED", url: null, objectCount: "3" },
    ]) {
      await assert.rejects(() =>
        fetchBulkOperationResult(
          async () => ({ data: { node } }),
          bulkOperationId,
        ),
      );
    }
    assert.deepEqual(
      await fetchBulkOperationResult(
        async () => ({
          data: {
            node: {
              status: "COMPLETED",
              url: null,
              objectCount: "0",
              rootObjectCount: "0",
            },
          },
        }),
        bulkOperationId,
      ),
      { url: null, rootObjectCount: 0, fileSize: null },
    );
    assert.equal(
      (
        await fetchBulkOperationResult(
          async () => ({
            data: {
              node: {
                status: "COMPLETED",
                url: "https://cdn.shopify.com/result.jsonl",
                rootObjectCount: "2",
                fileSize: "4096",
              },
            },
          }),
          bulkOperationId,
        )
      ).fileSize,
      4096,
    );
    for (const rootObjectCount of [
      undefined,
      "-1",
      "1.5",
      "99999999999999999999",
    ]) {
      assert.equal(
        (
          await fetchBulkOperationResult(
            async () => ({
              data: {
                node: {
                  status: "COMPLETED",
                  url: "https://cdn.shopify.com/result.jsonl",
                  rootObjectCount,
                },
              },
            }),
            bulkOperationId,
          )
        ).rootObjectCount,
        null,
      );
    }
    await assert.rejects(
      () =>
        fetchBulkOperationResult(
          async () => ({ errors: "Invalid API key" }),
          bulkOperationId,
        ),
      /Invalid API key/,
    );
  });

  it("cancels an export and reports a refusal", async () => {
    const calls: Variables[] = [];
    await cancelBulkOperation(async (query, variables) => {
      assert.match(query, /bulkOperationCancel\(id: \$id\)/);
      calls.push(variables);
      return { data: { bulkOperationCancel: { userErrors: [] } } };
    }, bulkOperationId);
    assert.deepEqual(calls, [{ id: bulkOperationId }]);
    await assert.rejects(
      cancelBulkOperation(
        async () => ({
          data: {
            bulkOperationCancel: {
              userErrors: [{ field: null, message: "Already completed" }],
            },
          },
        }),
        bulkOperationId,
      ),
      /Already completed/,
    );
  });

  it("reads where a pending export stands", async () => {
    const state = (node: unknown) =>
      readBulkOperationState(async () => ({ data: { node } }), bulkOperationId);
    assert.equal(await state({ status: "COMPLETED", url: null }), "completed");
    for (const status of ["FAILED", "CANCELED", "EXPIRED"])
      assert.equal(await state({ status }), "failed");
    // A missing operation can never complete.
    assert.equal(await state(null), "failed");
    for (const node of [{ status: "RUNNING" }, { status: "CANCELING" }])
      assert.equal(await state(node), "running");
    await assert.rejects(
      readBulkOperationState(
        async () => ({ errors: [{ message: "Throttled" }] }),
        bulkOperationId,
      ),
      /Throttled/,
    );
  });
});

describe("listing source ingestion configuration", () => {
  for (const status of [201, 204]) {
    it(`accepts provider ${status} and sends canonical domain and credentials`, async () => {
      const fetchMock = mock.fn(async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        assert.equal(request.method, "PUT");
        assert.equal(
          request.url,
          `${apiBaseUrl}/v1/listing-sources/${listingSourceId}/ingestion-configurations/shopify`,
        );
        assert.equal(
          request.headers.get("Authorization"),
          `Bearer ${accessToken}`,
        );
        assert.deepEqual(await request.json(), {
          domain: shopDomain,
          language: "de",
          currency: "EUR",
        });
        return new Response(null, { status });
      });
      await withFetch(fetchMock as typeof fetch, async () => {
        await putShopifyIngestionConfiguration(
          apiBaseUrl,
          listingSourceId,
          accessToken,
          { primaryLocale: "de", currencyCode: "EUR" },
          shopDomain,
        );
        assert.equal(fetchMock.mock.callCount(), 1);
      });
    });
  }

  it("sends required currency but omits language for unsupported locale", async () => {
    await withFetch(
      (async (input: RequestInfo | URL) => {
        assert.deepEqual(await asRequest(input).json(), {
          domain: shopDomain,
          currency: "JPY",
        });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      async () => {
        await putShopifyIngestionConfiguration(
          apiBaseUrl,
          listingSourceId,
          accessToken,
          { primaryLocale: "sv", currencyCode: "JPY" },
          shopDomain,
        );
      },
    );
  });

  it("rejects provider errors rather than treating them as configuration success", async () => {
    await withFetch(
      (async () =>
        jsonResponse({ error: "Invalid domain" }, 400)) as typeof fetch,
      async () => {
        await assert.rejects(() =>
          putShopifyIngestionConfiguration(
            apiBaseUrl,
            listingSourceId,
            accessToken,
            { currencyCode: "EUR" },
            shopDomain,
          ),
        );
      },
    );
  });
});

describe("async product listing batches", () => {
  it("derives deterministic, distinct verb/batch keys from the bulk operation", () => {
    const put0 = createBackfillIdempotencyKey(bulkOperationId, "put", 0);
    assert.equal(put0, createBackfillIdempotencyKey(bulkOperationId, "put", 0));
    assert.notEqual(
      put0,
      createBackfillIdempotencyKey(bulkOperationId, "delete", 0),
    );
    assert.notEqual(
      put0,
      createBackfillIdempotencyKey(bulkOperationId, "put", 1),
    );
    assert.match(put0, /^[\x21-\x7e]{1,128}$/);
    assert.doesNotMatch(put0, /,/);
  });

  for (const verb of ["put", "delete"] as const) {
    it(`sends ${verb.toUpperCase()} with a stable Idempotency-Key and returns report failures`, async () => {
      const items =
        verb === "put"
          ? [
              transformProduct(
                makeProduct(),
                [],
                "29.99",
                "en",
                "EUR",
                shopDomain,
              ),
            ]
          : [transformWithdrawal(makeProduct())];
      const idempotencyKey = createBackfillIdempotencyKey(
        bulkOperationId,
        verb,
        0,
      );
      const fetchMock = mock.fn(async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        assert.equal(request.method.toLowerCase(), verb);
        assert.equal(
          request.url,
          `${apiBaseUrl}/v1/listing-sources/${listingSourceId}/product-listings/async`,
        );
        assert.equal(
          request.headers.get("Authorization"),
          `Bearer ${accessToken}`,
        );
        assert.equal(request.headers.get("Idempotency-Key"), idempotencyKey);
        assert.deepEqual(await request.json(), items);
        return jsonResponse(
          report(0, [
            {
              index: 0,
              sourceListingId: "12345",
              error: "BAD_BODY_VALUE",
              retryable: false,
            },
          ]),
          400,
        );
      });
      await withFetch(fetchMock as typeof fetch, async () => {
        assert.deepEqual(
          await sendProductBatch(
            items,
            apiBaseUrl,
            listingSourceId,
            accessToken,
            verb,
            idempotencyKey,
          ),
          ["12345"],
        );
        assert.equal(fetchMock.mock.callCount(), 1);
      });
    });
  }

  it("reads partial failures from an accepted 202 report", async () => {
    const items = [
      transformProduct(makeProduct(), [], null, "en", "EUR", shopDomain),
      transformProduct(
        makeProduct({ id: "gid://shopify/Product/2" }),
        [],
        null,
        "en",
        "EUR",
        shopDomain,
      ),
    ];
    await withFetch(
      (async () =>
        jsonResponse(
          report(1, [
            {
              index: 1,
              sourceListingId: "2",
              error: "BAD_BODY_VALUE",
              retryable: false,
            },
          ]),
        )) as typeof fetch,
      async () => {
        assert.deepEqual(
          await sendProductBatch(
            items,
            apiBaseUrl,
            listingSourceId,
            accessToken,
            "put",
            "batch-1",
          ),
          ["2"],
        );
      },
    );
  });

  it("uses the report index when a failed source listing ID cannot be echoed", async () => {
    const items = [
      transformWithdrawal(makeProduct()),
      transformWithdrawal(makeProduct({ id: "gid://shopify/Product/2" })),
    ];
    await withFetch(
      (async () =>
        jsonResponse(
          report(1, [{ index: 1, error: "BAD_BODY_VALUE", retryable: false }]),
        )) as typeof fetch,
      async () => {
        assert.deepEqual(
          await sendProductBatch(
            items,
            apiBaseUrl,
            listingSourceId,
            accessToken,
            "delete",
            "batch-index",
          ),
          ["2"],
        );
      },
    );
  });

  it("rejects a non-report API error rather than counting it as admitted", async () => {
    await withFetch(
      (async () =>
        jsonResponse({ error: "INVALID_CREDENTIALS" }, 401)) as typeof fetch,
      async () => {
        await assert.rejects(() =>
          sendProductBatch(
            [transformWithdrawal(makeProduct())],
            apiBaseUrl,
            listingSourceId,
            accessToken,
            "delete",
            "bad-credentials",
          ),
        );
      },
    );
  });

  it("rejects duplicate failure indexes, negative counts and malformed failures", async () => {
    const items = [{ sourceListingId: "1" }, { sourceListingId: "2" }];
    for (const value of [
      report(0, [
        { index: 0, retryable: false, error: "BAD_BODY_VALUE" },
        { index: 0, retryable: false, error: "BAD_BODY_VALUE" },
      ]),
      report(-1, [
        { index: 0, retryable: false, error: "BAD_BODY_VALUE" },
        { index: 1, retryable: false, error: "BAD_BODY_VALUE" },
        { index: 1, retryable: false, error: "BAD_BODY_VALUE" },
      ]),
      { submissionId: "s", acceptedCount: 1, failures: [null] },
    ]) {
      await withFetch(
        (async () => jsonResponse(value)) as typeof fetch,
        async () => {
          await assert.rejects(
            () =>
              sendProductBatch(
                items,
                apiBaseUrl,
                listingSourceId,
                accessToken,
                "delete",
                "invalid-report",
              ),
            /admission/,
          );
        },
      );
    }
  });

  it("retries the unchanged entire batch with the same key on retryable report failures", async () => {
    const items = [transformWithdrawal(makeProduct())];
    const requests: Array<{ key: string | null; body: unknown }> = [];
    await withFetch(
      (async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        requests.push({
          key: request.headers.get("Idempotency-Key"),
          body: await request.json(),
        });
        return requests.length === 1
          ? jsonResponse(
              report(0, [
                {
                  index: 0,
                  sourceListingId: "12345",
                  error: "ENQUEUE_UNCONFIRMED",
                  retryable: true,
                },
              ]),
              503,
            )
          : jsonResponse(report(1));
      }) as typeof fetch,
      async () => {
        assert.deepEqual(
          await sendProductBatch(
            items,
            apiBaseUrl,
            listingSourceId,
            accessToken,
            "delete",
            "retry-key",
          ),
          [],
        );
      },
    );
    assert.ok(requests.length >= 2);
    assert.deepEqual(
      requests,
      requests.map(() => ({ key: "retry-key", body: items })),
    );
  });

  it("retries a transient pre-evaluation 503 with the same full batch and key", async () => {
    const items = [transformWithdrawal(makeProduct())];
    const requests: Array<{ key: string | null; body: unknown }> = [];
    await withFetch(
      (async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        requests.push({
          key: request.headers.get("Idempotency-Key"),
          body: await request.json(),
        });
        return requests.length === 1
          ? jsonResponse({ error: "DEPENDENCY_UNAVAILABLE" }, 503)
          : jsonResponse(report(1));
      }) as typeof fetch,
      async () => {
        assert.deepEqual(
          await sendProductBatch(
            items,
            apiBaseUrl,
            listingSourceId,
            accessToken,
            "delete",
            "retry-503",
          ),
          [],
        );
      },
    );
    assert.deepEqual(requests, [
      { key: "retry-503", body: items },
      { key: "retry-503", body: items },
    ]);
  });

  it("retries a network failure with the same key and unchanged payload", async () => {
    const requests: Array<{ key: string | null; body: unknown }> = [];
    const items = [transformWithdrawal(makeProduct())];
    await withFetch(
      (async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        requests.push({
          key: request.headers.get("Idempotency-Key"),
          body: await request.json(),
        });
        if (requests.length === 1) throw new TypeError("Connection reset");
        return jsonResponse(report(1));
      }) as typeof fetch,
      async () => {
        assert.deepEqual(
          await sendProductBatch(
            items,
            apiBaseUrl,
            listingSourceId,
            accessToken,
            "delete",
            "network-retry",
          ),
          [],
        );
      },
    );
    assert.ok(requests.length >= 2);
    assert.deepEqual(
      requests,
      requests.map(() => ({ key: "network-retry", body: items })),
    );
  });
});

const resultUrl = "https://cdn.shopify.com/result.jsonl";

function jsonl(products: BulkJsonlProduct[]) {
  return products.map((product) => JSON.stringify(product)).join("\n");
}

// Shopify reads for one import step: the completed export, granted scopes, the
// channel connection and its publication.
function stepGraphql({
  rootObjectCount = "0",
  fileSize,
  ...channel
}: {
  rootObjectCount?: string;
  fileSize?: string;
} & ChannelState = {}): GraphqlRequestFn {
  return async (query, variables) =>
    isChannelQuery(query)
      ? channelResponse(
          query,
          { publication: { id: publicationId }, ...channel },
          variables,
        )
      : {
          data: {
            node: {
              status: "COMPLETED",
              objectCount: rootObjectCount,
              rootObjectCount,
              fileSize,
              url: rootObjectCount === "0" ? null : resultUrl,
            },
          },
        };
}

// Fake Shopify export download plus Aura async writes. The download serves
// byte ranges in `chunk`-byte chunks as they are read, unless `ranges` is off,
// and `cut` ends a download with a connection error after that many bytes.
function fakeCatalog(
  products: BulkJsonlProduct[] | string | Uint8Array,
  respond?: (body: Array<{ sourceListingId: string }>) => Response,
  {
    ranges = true,
    chunk = 64 * 1024,
    cut = (_download: number): number | undefined => undefined,
  } = {},
) {
  const writes: Array<{ method: string; key: string | null; ids: string[] }> =
    [];
  // Requested start and bytes served of every download.
  const downloads: Array<{ start: number; served: number }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = asRequest(input, init);
    if (request.url === resultUrl) {
      const bytes =
        products instanceof Uint8Array
          ? products
          : bytesOf(typeof products === "string" ? products : jsonl(products));
      const range = ranges
        ? /^bytes=(\d+)-$/.exec(request.headers.get("Range") ?? "")
        : null;
      const start = range ? Number(range[1]) : 0;
      if (start >= bytes.length && range)
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${bytes.length}` },
        });
      const download = { start, served: 0 };
      const limit = cut(downloads.length);
      downloads.push(download);
      const body = bytes.subarray(start);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (limit !== undefined && download.served >= limit)
            return controller.error(new TypeError("terminated"));
          if (download.served >= body.length) return controller.close();
          const next = body.slice(
            download.served,
            Math.min(
              download.served + chunk,
              limit ?? body.length,
              body.length,
            ),
          );
          download.served += next.length;
          controller.enqueue(next);
        },
      });
      return range
        ? new Response(stream, {
            status: 206,
            headers: {
              "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
            },
          })
        : new Response(stream);
    }
    const body = (await request.json()) as Array<{ sourceListingId: string }>;
    writes.push({
      method: request.method,
      key: request.headers.get("Idempotency-Key"),
      ids: body.map((item) => item.sourceListingId),
    });
    return respond?.(body) ?? jsonResponse(report(body.length));
  }) as typeof fetch;
  return { fetcher, writes, downloads };
}

function newJob(): CatalogImportJob {
  return {
    shop: shopDomain,
    generation: 1,
    bulkOperationId,
    plan: EXPORT_PLAN_VERSION,
    queuedAt: Date.now(),
    admitted: true,
    admittedAt: Date.now(),
    offset: 0,
    cursor: 0,
    part: 0,
    total: 0,
    eligible: 0,
    rejected: 0,
    unknown: 0,
    failed: 0,
    withdrawn: 0,
    attempts: 0,
  };
}

async function runToCompletion(
  products: BulkJsonlProduct[],
  graphql = stepGraphql({ rootObjectCount: String(products.length) }),
) {
  const job = newJob();
  const step = await runCatalogImportStep(
    job,
    makeContext(),
    graphql,
    Number.POSITIVE_INFINITY,
    async () => {},
  );
  assert.equal(step.done, true);
  return { job, status: step.status };
}

describe("Aura channel eligibility", () => {
  it("admits active products only on explicit current-publication membership", () => {
    assert.equal(classifyShopifyBackfillAction(makeProduct()), "upsert");
    assert.equal(
      classifyShopifyBackfillAction(
        makeProduct({ publishedOnPublication: false }),
      ),
      "withdraw",
    );
    for (const publishedOnPublication of [undefined, null, "true", 1]) {
      assert.equal(
        classifyShopifyBackfillAction(
          makeProduct({ publishedOnPublication } as never),
        ),
        "unknown",
      );
    }
    // Status rules are unchanged regardless of channel membership.
    for (const status of ["DRAFT", "ARCHIVED"]) {
      assert.equal(
        classifyShopifyBackfillAction(makeProduct({ status })),
        "withdraw",
      );
    }
    assert.equal(
      classifyShopifyBackfillAction(makeProduct({ status: "UNLISTED" })),
      "ignore",
    );
  });

  it("plans deterministic segments of at most 100 products with unique keys", async () => {
    const products = Array.from({ length: 101 }, (_, index) =>
      makeProduct({
        id: `gid://shopify/Product/${index + 1}`,
        handle: `clock-${index + 1}`,
      }),
    );
    products.push(
      makeProduct({ id: "gid://shopify/Product/102", status: "ARCHIVED" }),
    );
    const segments = await readSegments(jsonl(products));
    const plans = segments.map((segment, index) =>
      planSegment(segment, index, makeContext()),
    );
    assert.deepEqual(
      plans.flatMap(({ batches }) =>
        batches.map(({ verb, index, items }) => [verb, index, items.length]),
      ),
      [
        ["put", 0, 100],
        ["put", 1, 1],
        ["delete", 1, 1],
      ],
    );
    assert.deepEqual(
      (await readSegments(jsonl(products), { chunk: 7 })).map(
        (segment, index) => planSegment(segment, index, makeContext()),
      ),
      plans,
    );
    assert.deepEqual(
      plans.map(({ eligible, rejected, unknown }) => [
        eligible,
        rejected.length,
        unknown,
      ]),
      [
        [100, 0, 0],
        [1, 0, 0],
      ],
    );
  });
});

describe("catalog import steps", () => {
  it("imports only products published to Aura and withdraws those published elsewhere or nowhere", async () => {
    const products = [
      makeProduct({ id: "gid://shopify/Product/301" }),
      // Published only to the Online Store: a storefront URL is not
      // membership in Aura's channel.
      makeProduct({
        id: "gid://shopify/Product/302",
        publishedOnPublication: false,
      }),
      // Active but published to no channel.
      makeProduct({
        id: "gid://shopify/Product/303",
        publishedOnPublication: false,
        onlineStoreUrl: null,
      }),
      // Published to Aura and out of stock keeps its availability.
      makeProduct({ id: "gid://shopify/Product/304", totalInventory: 0 }),
      makeProduct({ id: "gid://shopify/Product/305", status: "DRAFT" }),
      makeProduct({ id: "gid://shopify/Product/306", status: "UNLISTED" }),
    ];
    const catalog = fakeCatalog(products);
    let upsertBody: unknown;
    await withFetch(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = asRequest(input);
        if (request.method === "PUT") upsertBody = await request.clone().json();
        return catalog.fetcher(input, init);
      }) as typeof fetch,
      async () => {
        const { status } = await runToCompletion(products);
        assert.deepEqual(status, {
          phase: "submitted",
          total: 6,
          eligible: 2,
          withdrawn: 3,
          failed: 0,
        });
      },
    );
    assert.deepEqual(catalog.writes, [
      {
        method: "PUT",
        key: "shopify-backfill-789-put-0",
        ids: ["301", "304"],
      },
      {
        method: "DELETE",
        key: "shopify-backfill-789-delete-0",
        ids: ["302", "303", "305"],
      },
    ]);
    assert.deepEqual(
      (upsertBody as Array<{ availability: string }>).map(
        (item) => item.availability,
      ),
      ["IN_STOCK", "OUT_OF_STOCK"],
    );
  });

  it("withdraws every product for a valid empty channel selection", async () => {
    const products = [
      makeProduct({
        id: "gid://shopify/Product/1",
        publishedOnPublication: false,
      }),
      makeProduct({
        id: "gid://shopify/Product/2",
        publishedOnPublication: false,
      }),
    ];
    const catalog = fakeCatalog(products);
    await withFetch(catalog.fetcher, async () => {
      const { status } = await runToCompletion(products);
      assert.equal(status.phase, "submitted");
      assert.equal(status.eligible, 0);
      assert.equal(status.withdrawn, 2);
    });
    assert.deepEqual(
      catalog.writes.map(({ method, ids }) => ({ method, ids })),
      [{ method: "DELETE", ids: ["1", "2"] }],
    );
  });

  it("completes an empty shop without downloads or writes", async () => {
    const catalog = fakeCatalog([]);
    await withFetch(catalog.fetcher, async () => {
      const { status } = await runToCompletion([]);
      assert.deepEqual(status, {
        phase: "submitted",
        total: 0,
        eligible: 0,
        withdrawn: 0,
        failed: 0,
      });
    });
    assert.deepEqual(catalog.writes, []);
  });

  it("never upserts or withdraws on unknown membership and never reports it complete", async () => {
    const products = [
      makeProduct({
        id: "gid://shopify/Product/401",
        publishedOnPublication: undefined,
      }),
      makeProduct({
        id: "gid://shopify/Product/402",
        publishedOnPublication: "true" as never,
      }),
      makeProduct({ id: "gid://shopify/Product/403" }),
    ];
    const catalog = fakeCatalog(products);
    await withFetch(catalog.fetcher, async () => {
      const { status } = await runToCompletion(products);
      assert.deepEqual(status, {
        phase: "failed",
        total: 3,
        eligible: 1,
        withdrawn: 0,
        failed: 2,
        error: "INCOMPLETE_EXPORT",
      });
    });
    assert.deepEqual(
      catalog.writes.map(({ method, ids }) => ({ method, ids })),
      [{ method: "PUT", ids: ["403"] }],
    );
  });

  it("reports a short export or a missing root count as incomplete", async () => {
    const products = [makeProduct()];
    const catalog = fakeCatalog(products);
    await withFetch(catalog.fetcher, async () => {
      for (const graphql of [
        stepGraphql({ rootObjectCount: "2" }),
        async (query: string, variables: Variables) => {
          const response = await stepGraphql({ rootObjectCount: "1" })(
            query,
            variables,
          );
          const node = response.data?.node as Record<string, unknown>;
          if (node && "rootObjectCount" in node) delete node.rootObjectCount;
          return response;
        },
      ]) {
        const { status } = await runToCompletion(products, graphql);
        assert.equal(status.phase, "failed");
        assert.equal(status.error, "INCOMPLETE_EXPORT");
        assert.equal(status.eligible, 1);
      }
    });
  });

  for (const [name, graphql, error] of [
    [
      "a revoked product listing scope",
      stepGraphql({ rootObjectCount: "1", scopes: ["read_products"] }),
      "MISSING_SCOPE",
    ],
    [
      "a revoked publication scope",
      stepGraphql({
        rootObjectCount: "1",
        scopes: ["read_products", "read_product_listings"],
      }),
      "MISSING_SCOPE",
    ],
    [
      "a removed channel connection",
      stepGraphql({ rootObjectCount: "1", channel: null }),
      "MISSING_CHANNEL",
    ],
    [
      "a channel rebound to another listing source",
      stepGraphql({
        rootObjectCount: "1",
        channel: boundChannel({ accountId: `ls_${"1".repeat(26)}` }),
      }),
      "MISSING_CHANNEL",
    ],
    [
      "a removed publication",
      stepGraphql({ rootObjectCount: "1", publication: null }),
      "MISSING_PUBLICATION",
    ],
    [
      "a replaced publication",
      stepGraphql({
        rootObjectCount: "1",
        publication: { id: "gid://shopify/Publication/999" },
      }),
      "PUBLICATION_CHANGED",
    ],
  ] as const) {
    it(`discards the snapshot without writes after ${name}`, async () => {
      const catalog = fakeCatalog([makeProduct()]);
      await withFetch(catalog.fetcher, async () => {
        const { status } = await runToCompletion([makeProduct()], graphql);
        assert.deepEqual(status, {
          phase: "failed",
          total: 0,
          eligible: 0,
          withdrawn: 0,
          failed: 0,
          error,
        });
      });
      assert.deepEqual(catalog.writes, []);
    });
  }

  it("rejects failed Shopify reads so the caller can retry the step", async () => {
    const catalog = fakeCatalog([makeProduct()]);
    await withFetch(catalog.fetcher, async () => {
      await assert.rejects(() =>
        runCatalogImportStep(
          newJob(),
          makeContext(),
          async () => ({ data: { node: { status: "RUNNING" } } }),
          Number.POSITIVE_INFINITY,
          async () => {},
        ),
      );
    });
    assert.deepEqual(catalog.writes, []);
  });

  it("returns reported failures rather than treating admission as success", async () => {
    const products = [
      makeProduct(),
      makeProduct({ id: "gid://shopify/Product/6", status: "DRAFT" }),
    ];
    const catalog = fakeCatalog(products, (body) =>
      jsonResponse(
        report(
          0,
          body.map((product, index) => ({
            index,
            sourceListingId: product.sourceListingId,
            error: "BAD_BODY_VALUE",
            retryable: false,
          })),
        ),
        400,
      ),
    );
    await withFetch(catalog.fetcher, async () => {
      const { status } = await runToCompletion(products);
      assert.equal(status.phase, "failed");
      assert.equal(status.failed, 2);
      assert.equal(status.withdrawn, 0);
      assert.equal(status.error, undefined);
    });
  });

  it("stops at its deadline and resumes at the next batch with the same keys", async () => {
    const products = Array.from({ length: 250 }, (_, index) =>
      makeProduct({
        id: `gid://shopify/Product/${index + 1}`,
        handle: `clock-${index + 1}`,
      }),
    );
    const catalog = fakeCatalog(products);
    const graphql = stepGraphql({ rootObjectCount: "250" });
    const persisted: CatalogImportJob[] = [];
    const checkpoint = async (job: CatalogImportJob) => {
      persisted.push(structuredClone(job));
    };
    let now = 1_000_000;
    const clock = mock.method(Date, "now", () => now);
    try {
      await withFetch(
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          if (asRequest(input).method === "PUT") now += 15_000;
          return catalog.fetcher(input, init);
        }) as typeof fetch,
        async () => {
          const job = newJob();
          const first = await runCatalogImportStep(
            job,
            makeContext(),
            graphql,
            20_000,
            checkpoint,
          );
          assert.equal(first.done, false);
          assert.equal(first.status.phase, "processing");
          assert.equal(job.cursor, 2);
          // Resume from the last persisted checkpoint, as after eviction.
          const resumed = structuredClone(persisted.at(-1) as CatalogImportJob);
          const second = await runCatalogImportStep(
            resumed,
            makeContext(),
            graphql,
            20_000,
            checkpoint,
          );
          assert.equal(second.done, true);
          assert.equal(second.status.phase, "submitted");
          assert.equal(second.status.eligible, 250);
        },
      );
    } finally {
      clock.mock.restore();
    }
    assert.deepEqual(
      catalog.writes.map((write) => write.key),
      [0, 1, 2].map((index) => `shopify-backfill-789-put-${index}`),
    );
  });

  it("never lets a slow export download starve batch submission", async () => {
    const products = Array.from({ length: 450 }, (_, index) =>
      makeProduct({
        id: `gid://shopify/Product/${index + 1}`,
        handle: `clock-${index + 1}`,
      }),
    );
    const catalog = fakeCatalog(products);
    const graphql = stepGraphql({ rootObjectCount: "450" });
    const persisted: CatalogImportJob[] = [];
    let now = 1_000_000;
    const clock = mock.method(Date, "now", () => now);
    try {
      await withFetch(
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = asRequest(input);
          // Every step spends more than its whole budget on the download.
          if (request.url === resultUrl) now += 21_000;
          if (request.method === "PUT") now += 15_000;
          return catalog.fetcher(input, init);
        }) as typeof fetch,
        async () => {
          let job = newJob();
          for (let step = 0; step < 3; step++) {
            const before = job.cursor;
            const result = await runCatalogImportStep(
              job,
              makeContext(),
              graphql,
              20_000,
              async (next) => {
                persisted.push(structuredClone(next));
              },
            );
            assert.ok(job.cursor > before, `step ${step} made no progress`);
            if (result.done) break;
            job = structuredClone(persisted.at(-1) as CatalogImportJob);
          }
          assert.equal(job.cursor, 5);
        },
      );
    } finally {
      clock.mock.restore();
    }
    assert.equal(catalog.writes.length, 5);
  });

  it("retries an unreadable publication instead of ending the import", async () => {
    const catalog = fakeCatalog([makeProduct()]);
    const readable = stepGraphql({ rootObjectCount: "1" });
    await withFetch(catalog.fetcher, async () => {
      await assert.rejects(
        () =>
          runCatalogImportStep(
            newJob(),
            makeContext(),
            async (query, variables) => {
              if (query.includes("AuraChannelCatalogPublication"))
                throw new Error("Network connection lost");
              return readable(query, variables);
            },
            Number.POSITIVE_INFINITY,
            async () => {},
          ),
        /publication could not be read/,
      );
    });
    assert.deepEqual(catalog.writes, []);
  });

  it("replays an unconfirmed batch under its original key after interruption", async () => {
    const products = Array.from({ length: 150 }, (_, index) =>
      makeProduct({
        id: `gid://shopify/Product/${index + 1}`,
        handle: `clock-${index + 1}`,
      }),
    );
    const catalog = fakeCatalog(products);
    const graphql = stepGraphql({ rootObjectCount: "150" });
    const persisted: CatalogImportJob[] = [];
    await withFetch(catalog.fetcher, async () => {
      await assert.rejects(() =>
        runCatalogImportStep(
          newJob(),
          makeContext(),
          graphql,
          Number.POSITIVE_INFINITY,
          async (job) => {
            // The second batch is sent, but its checkpoint is lost.
            if (job.cursor === 2) throw new Error("evicted");
            persisted.push(structuredClone(job));
          },
        ),
      );
      const step = await runCatalogImportStep(
        structuredClone(persisted.at(-1) as CatalogImportJob),
        makeContext(),
        graphql,
        Number.POSITIVE_INFINITY,
        async () => {},
      );
      assert.equal(step.done, true);
    });
    assert.deepEqual(
      catalog.writes.map((write) => write.key),
      [
        "shopify-backfill-789-put-0",
        "shopify-backfill-789-put-1",
        "shopify-backfill-789-put-1",
      ],
    );
    assert.deepEqual(catalog.writes[1].ids, catalog.writes[2].ids);
  });
});

// A grouped export of `count` products with multibyte titles, image URLs
// and several variants each, in a fixed mix of statuses and memberships:
// every 17th product is a draft and every 5th is not published to Aura.
function generatedExport(count: number) {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `gid://shopify/Product/${i}`;
    lines.push(
      JSON.stringify(
        makeProduct({
          id,
          title: `Pendule ${i} – 時計 🕰️ Ünïcødé`,
          handle: `pendule-${i}`,
          onlineStoreUrl: null,
          status: i % 17 === 0 ? "DRAFT" : "ACTIVE",
          publishedOnPublication: i % 5 !== 0,
        }),
      ),
    );
    for (let image = 0; image < i % 4; image++)
      lines.push(
        JSON.stringify({
          id: `gid://shopify/ProductImage/${i}0${image}`,
          url: `https://cdn.shopify.com/s/files/${i}/größe-${image}.jpg`,
          __parentId: id,
        }),
      );
    for (let variant = 0; variant <= i % 3; variant++)
      lines.push(
        JSON.stringify({
          id: `gid://shopify/ProductVariant/${i}0${variant}`,
          price: `${i}.${variant}0`,
          __parentId: id,
        }),
      );
  }
  return `${lines.join("\n")}\n`;
}

const isWithdrawn = (i: number) => i % 17 === 0 || i % 5 === 0;

// Runs steps until the import is done, each resumed from the last persisted
// checkpoint as after an eviction.
async function runSteps(
  graphql: GraphqlRequestFn,
  { budget = Number.POSITIVE_INFINITY, maxSteps = 100 } = {},
) {
  const persisted: CatalogImportJob[] = [];
  let job = newJob();
  for (let steps = 1; steps <= maxSteps; steps++) {
    const step = await runCatalogImportStep(
      job,
      makeContext(),
      graphql,
      budget,
      async (next) => {
        persisted.push(structuredClone(next));
      },
    );
    if (step.done) return { status: step.status, steps, persisted };
    job = structuredClone(persisted.at(-1) as CatalogImportJob);
  }
  throw new Error("Import did not finish");
}

// Advances the clock on every Aura batch request, so a step's budget ends
// after its first segment.
function slowBatches(fetcher: typeof fetch, run: () => Promise<void>) {
  let now = 1_000_000;
  const clock = mock.method(Date, "now", () => now);
  return withFetch(
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (asRequest(input, init).url !== resultUrl) now += 15_000;
      return fetcher(input, init);
    }) as typeof fetch,
    run,
  ).finally(() => clock.mock.restore());
}

describe("streamed catalog exports", () => {
  it("splits a large generated export into byte-exact segments whatever the chunking", async () => {
    const content = bytesOf(generatedExport(2_500));
    const size = content.length;
    const segments = await readSegments(content, { size });
    assert.deepEqual(
      segments.map(({ products }) => products.length),
      Array(25).fill(100),
    );
    // Contiguous byte ranges that start at product lines and cover the file.
    segments.forEach((segment, index) => {
      assert.equal(segment.start, index ? segments[index - 1].end : 0);
      assert.match(
        new TextDecoder().decode(
          content.subarray(segment.start, segment.start + 30),
        ),
        /^\{"id":"gid:\/\/shopify\/Product\//,
      );
    });
    assert.equal(segments.at(-1)?.end, size);
    // Multibyte text, children and the first variant's price survive.
    const third = segments[0].products[2];
    assert.equal(third.product.title, "Pendule 3 – 時計 🕰️ Ünïcødé");
    assert.deepEqual(third.images, [
      "https://cdn.shopify.com/s/files/3/größe-0.jpg",
      "https://cdn.shopify.com/s/files/3/größe-1.jpg",
      "https://cdn.shopify.com/s/files/3/größe-2.jpg",
    ]);
    assert.equal(third.price, "3.00");
    // Lines and characters split across chunks give the same segments.
    assert.deepEqual(
      await readSegments(content, { chunk: 13, size }),
      segments,
    );
    const small = bytesOf(generatedExport(150));
    assert.deepEqual(
      await readSegments(small, { chunk: 1 }),
      await readSegments(small),
    );
    // Resumed at any segment boundary, the rest of the export is identical.
    for (const index of [1, 12, 24])
      assert.deepEqual(
        await readSegments(content, {
          offset: segments[index].start,
          chunk: 4096,
          size,
        }),
        segments.slice(index),
      );
  });

  it("closes a segment after 1 MiB of product and image lines, never counting skipped variants", async () => {
    const product = (i: number) => `gid://shopify/Product/${i}`;
    const imageHeavy: string[] = [];
    for (let i = 1; i <= 200; i++) {
      imageHeavy.push(JSON.stringify(makeProduct({ id: product(i) })));
      for (let image = 0; image < 30; image++)
        imageHeavy.push(
          JSON.stringify({
            id: `gid://shopify/ProductImage/${i}0${image}`,
            url: `https://cdn.shopify.com/${"ä".repeat(500)}/${image}.jpg`,
            __parentId: product(i),
          }),
        );
    }
    const segments = await readSegments(imageHeavy.join("\n"));
    assert.equal(
      segments.reduce((sum, { products }) => sum + products.length, 0),
      200,
    );
    for (const segment of segments) {
      assert.ok(segment.products.length < 100);
      // The segment ended at the first product after reaching the budget.
      const bytes = segment.end - segment.start;
      const perProduct = bytes / segment.products.length;
      assert.ok(bytes < SEGMENT_BYTES + perProduct + 1, String(bytes));
      if (segment !== segments.at(-1))
        assert.ok(bytes - perProduct < SEGMENT_BYTES);
    }

    const variantHeavy: string[] = [];
    for (let i = 1; i <= 100; i++) {
      variantHeavy.push(JSON.stringify(makeProduct({ id: product(i) })));
      for (let variant = 0; variant < 400; variant++)
        variantHeavy.push(
          JSON.stringify({
            id: `gid://shopify/ProductVariant/${i}0${variant}`,
            price: `${variant}.00`,
            __parentId: product(i),
          }),
        );
    }
    const content = variantHeavy.join("\n");
    assert.ok(bytesOf(content).length > 3 * SEGMENT_BYTES);
    const [only, ...rest] = await readSegments(content);
    assert.deepEqual(rest, []);
    assert.equal(only.products.length, 100);
    assert.ok(only.products.every(({ price }) => price === "0.00"));
  });

  it("rejects a line, a product or an export beyond the supported bytes", async () => {
    // Two UTF-8 bytes per character: the limit counts bytes, not characters.
    const title = "ü".repeat(MAX_EXPORT_LINE_BYTES / 2);
    assert.ok(title.length < MAX_EXPORT_LINE_BYTES);
    await assert.rejects(
      readSegments(`${JSON.stringify(makeProduct({ title }))}\n`),
      ExportCapacityError,
    );
    const images = Array.from({ length: 1_100 }, (_, image) =>
      JSON.stringify({
        id: `gid://shopify/ProductImage/${image}`,
        url: `https://cdn.shopify.com/${"x".repeat(1_000)}/${image}.jpg`,
        __parentId: makeProduct().id,
      }),
    );
    await assert.rejects(
      readSegments([JSON.stringify(makeProduct()), ...images].join("\n")),
      ExportCapacityError,
    );
    await assert.rejects(
      readSegments(generatedExport(10), { limit: 1_000 }),
      ExportCapacityError,
    );
    assert.equal(MAX_EXPORT_BYTES, 1024 ** 3);
    assert.equal(MAX_EXPORT_PRODUCTS, 100_000);
  });

  it("rejects malformed, partial and ungrouped lines", async () => {
    const product = (id: number) =>
      JSON.stringify(makeProduct({ id: `gid://shopify/Product/${id}` }));
    const image = JSON.stringify({
      id: "gid://shopify/ProductImage/1",
      url: "https://cdn.shopify.com/1.jpg",
      __parentId: "gid://shopify/Product/1",
    });
    for (const content of [
      // A partial last line.
      `${product(1)}\n{"id":"gid://shopify/Pro`,
      `${product(1)}\n[1]`,
      // A child after another product, or before any product.
      `${product(1)}\n${product(2)}\n${image}`,
      `${image}\n${product(1)}`,
      '{"title":"No ID"}',
    ])
      await assert.rejects(readSegments(content), MalformedExportError);
    const bytes = bytesOf(product(1));
    await assert.rejects(
      readSegments(
        new Uint8Array([...bytes.subarray(0, 40), 0xff, ...bytes.subarray(40)]),
      ),
      MalformedExportError,
    );
  });

  it("treats a download that ends before Shopify's file size as transient", async () => {
    const content = bytesOf(generatedExport(3));
    await assert.rejects(
      readSegments(content.subarray(0, content.length - 20), {
        size: content.length,
      }),
      (error: Error) =>
        !(error instanceof MalformedExportError) &&
        !(error instanceof ExportCapacityError) &&
        /cut off/.test(error.message),
    );
  });

  for (const [name, ranges, fileSize] of [
    ["byte ranges and Shopify's file size", true, true],
    ["byte ranges, ending on an unsatisfiable range", true, false],
    ["a server that ignores byte ranges", false, true],
  ] as const) {
    it(`resumes each step at its checkpoint with ${name}`, async () => {
      const content = generatedExport(1_050);
      const size = bytesOf(content).length;
      const segments = await readSegments(content);
      assert.equal(segments.length, 11);
      const catalog = fakeCatalog(content, undefined, { ranges, chunk: 4096 });
      const graphql = stepGraphql({
        rootObjectCount: "1050",
        fileSize: fileSize ? String(size) : undefined,
      });
      await slowBatches(catalog.fetcher, async () => {
        const { status, steps } = await runSteps(graphql, { budget: 20_000 });
        // One segment per step, then a step at the end of the file.
        assert.equal(steps, 12);
        const withdrawn = Array.from({ length: 1_050 }, (_, i) => i + 1).filter(
          isWithdrawn,
        ).length;
        assert.deepEqual(status, {
          phase: "submitted",
          total: 1_050,
          eligible: 1_050 - withdrawn,
          withdrawn,
          failed: 0,
        });
      });
      // Every step downloads from the previous step's checkpoint.
      assert.deepEqual(
        catalog.downloads.map(({ start }) => start),
        ranges ? segments.map(({ start }) => start) : Array(11).fill(0),
      );
      // Each batch is sent once, in order, under its segment's keys.
      assert.deepEqual(
        catalog.writes.map(({ key }) => key),
        segments.flatMap((_, index) => [
          `shopify-backfill-789-put-${index}`,
          `shopify-backfill-789-delete-${index}`,
        ]),
      );
      // With byte ranges the export is downloaded about once in total, not
      // once per step.
      const served = catalog.downloads.reduce(
        (sum, download) => sum + download.served,
        0,
      );
      if (ranges) assert.ok(served < 1.25 * size, `${served} of ${size}`);
    });
  }

  it("resumes an interrupted download at its last checkpoint without resending", async () => {
    const content = generatedExport(450);
    const size = bytesOf(content).length;
    const segments = await readSegments(content);
    const catalog = fakeCatalog(content, undefined, {
      chunk: 1_000,
      // The second download fails in a line of its first segment.
      cut: (download) =>
        download === 1
          ? Math.floor((segments[2].end - segments[2].start) / 2) + 7
          : undefined,
    });
    const graphql = stepGraphql({
      rootObjectCount: "450",
      fileSize: String(size),
    });
    const persisted: CatalogImportJob[] = [];
    const resume = () => structuredClone(persisted.at(-1) as CatalogImportJob);
    const step = (job: CatalogImportJob) =>
      runCatalogImportStep(
        job,
        makeContext(),
        graphql,
        40_000,
        async (next) => {
          persisted.push(structuredClone(next));
        },
      );
    await slowBatches(catalog.fetcher, async () => {
      assert.equal((await step(newJob())).done, false);
      assert.equal(resume().cursor, 2);
      await assert.rejects(step(resume()), /terminated/);
      // The checkpoint still points at the interrupted segment.
      assert.equal(resume().offset, segments[2].start);
      let result = await step(resume());
      while (!result.done) result = await step(resume());
      assert.equal(result.status.phase, "submitted");
      assert.equal(result.status.total, 450);
    });
    assert.deepEqual(
      catalog.downloads.map(({ start }) => start),
      [0, segments[2].start, segments[2].start, segments[4].start],
    );
    // Nothing of the partial segment was sent, and nothing was resent.
    assert.deepEqual(
      catalog.writes.map(({ key }) => key),
      segments.flatMap((_, index) => [
        `shopify-backfill-789-put-${index}`,
        `shopify-backfill-789-delete-${index}`,
      ]),
    );
  });

  it("ends a malformed export as incomplete without its unread products", async () => {
    const lines = generatedExport(250).split("\n");
    const broken = lines.findIndex((line) =>
      line.startsWith('{"id":"gid://shopify/Product/180"'),
    );
    lines[broken] = lines[broken].slice(0, 40);
    const catalog = fakeCatalog(lines.join("\n"));
    await withFetch(catalog.fetcher, async () => {
      const { status } = await runToCompletion(
        [],
        stepGraphql({ rootObjectCount: "250" }),
      );
      const withdrawn = Array.from({ length: 100 }, (_, i) => i + 1).filter(
        isWithdrawn,
      ).length;
      assert.deepEqual(status, {
        phase: "failed",
        total: 100,
        eligible: 100 - withdrawn,
        withdrawn,
        failed: 0,
        error: "INCOMPLETE_EXPORT",
      });
    });
    // Only the first segment was submitted; nothing is withdrawn for the
    // products the import could not read.
    assert.deepEqual(
      catalog.writes.map(({ key }) => key),
      ["shopify-backfill-789-put-0", "shopify-backfill-789-delete-0"],
    );
  });

  it("ends an export with an oversized line as too large", async () => {
    const lines = generatedExport(150).split("\n");
    lines.splice(
      lines.findIndex((line) =>
        line.startsWith('{"id":"gid://shopify/Product/120"'),
      ),
      1,
      JSON.stringify(
        makeProduct({
          id: "gid://shopify/Product/120",
          title: "x".repeat(MAX_EXPORT_LINE_BYTES),
        }),
      ),
    );
    const catalog = fakeCatalog(lines.join("\n"));
    await withFetch(catalog.fetcher, async () => {
      const { status } = await runToCompletion(
        [],
        stepGraphql({ rootObjectCount: "150" }),
      );
      assert.equal(status.phase, "failed");
      assert.equal(status.error, "EXPORT_TOO_LARGE");
      assert.equal(status.total, 100);
    });
    assert.equal(catalog.writes.length, 2);
  });

  it("refuses an export Shopify reports as too large before downloading it", async () => {
    for (const reported of [
      { rootObjectCount: String(MAX_EXPORT_PRODUCTS + 1) },
      { rootObjectCount: "1", fileSize: String(MAX_EXPORT_BYTES + 1) },
    ]) {
      const catalog = fakeCatalog([makeProduct()]);
      const error = mock.method(console, "error", () => {});
      try {
        await withFetch(catalog.fetcher, async () => {
          const { status } = await runToCompletion([], stepGraphql(reported));
          assert.deepEqual(status, {
            phase: "failed",
            total: 0,
            eligible: 0,
            withdrawn: 0,
            failed: 0,
            error: "EXPORT_TOO_LARGE",
          });
        });
      } finally {
        error.mock.restore();
      }
      assert.deepEqual(catalog.downloads, []);
      assert.deepEqual(catalog.writes, []);
    }
  });

  it("resumes a segment after its first batch without recounting or resending it", async () => {
    const content = generatedExport(150);
    const catalog = fakeCatalog(content);
    const graphql = stepGraphql({ rootObjectCount: "150" });
    const persisted: CatalogImportJob[] = [];
    let evicted = false;
    await withFetch(catalog.fetcher, async () => {
      await assert.rejects(
        runCatalogImportStep(
          newJob(),
          makeContext(),
          graphql,
          Number.POSITIVE_INFINITY,
          async (next) => {
            // The withdrawal batch is sent, but its checkpoint is lost.
            if (next.cursor === 1 && !evicted) {
              evicted = true;
              throw new Error("evicted");
            }
            persisted.push(structuredClone(next));
          },
        ),
        /evicted/,
      );
      const resumed = structuredClone(persisted.at(-1) as CatalogImportJob);
      assert.equal(resumed.part, 1);
      assert.equal(resumed.total, 100);
      const { status } = await runCatalogImportStep(
        resumed,
        makeContext(),
        graphql,
        Number.POSITIVE_INFINITY,
        async () => {},
      );
      const withdrawn = Array.from({ length: 150 }, (_, i) => i + 1).filter(
        isWithdrawn,
      ).length;
      assert.deepEqual(status, {
        phase: "submitted",
        total: 150,
        eligible: 150 - withdrawn,
        withdrawn,
        failed: 0,
      });
    });
    assert.deepEqual(
      catalog.writes.map(({ key }) => key),
      [
        "shopify-backfill-789-put-0",
        "shopify-backfill-789-delete-0",
        "shopify-backfill-789-delete-0",
        "shopify-backfill-789-put-1",
        "shopify-backfill-789-delete-1",
      ],
    );
    assert.deepEqual(catalog.writes[1].ids, catalog.writes[2].ids);
  });

  it("caps the products it streams, counting a resumed segment once", async () => {
    const content = generatedExport(100);
    const graphql = stepGraphql({
      rootObjectCount: String(MAX_EXPORT_PRODUCTS),
    });
    // The last segment of a catalog at the limit, after its upserts.
    const atLimit = fakeCatalog(content);
    await withFetch(atLimit.fetcher, async () => {
      const { status } = await runCatalogImportStep(
        { ...newJob(), part: 1, total: MAX_EXPORT_PRODUCTS },
        makeContext(),
        graphql,
        Number.POSITIVE_INFINITY,
        async () => {},
      );
      assert.equal(status.phase, "submitted");
    });
    assert.deepEqual(
      atLimit.writes.map(({ key }) => key),
      ["shopify-backfill-789-delete-0"],
    );
    // Shopify reported fewer products than the export holds.
    const beyond = fakeCatalog(content);
    const error = mock.method(console, "error", () => {});
    try {
      await withFetch(beyond.fetcher, async () => {
        const { status } = await runCatalogImportStep(
          { ...newJob(), total: MAX_EXPORT_PRODUCTS - 50 },
          makeContext(),
          graphql,
          Number.POSITIVE_INFINITY,
          async () => {},
        );
        assert.equal(status.error, "EXPORT_TOO_LARGE");
      });
    } finally {
      error.mock.restore();
    }
    assert.deepEqual(beyond.writes, []);
  });

  it("never reports an export of unknown size complete", async () => {
    const products = [makeProduct()];
    // No file size from Shopify, and a response that reports none.
    const catalog = fakeCatalog(products, undefined, { ranges: false });
    await withFetch(catalog.fetcher, async () => {
      const { status } = await runToCompletion(products);
      assert.equal(status.phase, "failed");
      assert.equal(status.error, "INCOMPLETE_EXPORT");
      assert.equal(status.eligible, 1);
    });
    assert.equal(catalog.writes.length, 1);
  });

  it("times out a stalled or too slow download and a late response", async () => {
    const pending = () =>
      new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const stalled = new ExportLines(pending().getReader(), 0).next();
      mock.timers.tick(EXPORT_READ_TIMEOUT_MS);
      await assert.rejects(stalled, /stalled/);
      // The response must arrive within the timeout as well.
      await withFetch(
        (async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          )) as typeof fetch,
        async () => {
          const response = openBackfillExport(
            { url: resultUrl, rootObjectCount: 1, fileSize: 10 },
            0,
          );
          mock.timers.tick(EXPORT_READ_TIMEOUT_MS);
          await assert.rejects(response, /aborted/);
        },
      );
    } finally {
      mock.timers.reset();
    }
    // A step stops reading at its deadline, however steadily chunks arrive.
    await assert.rejects(
      new ExportLines(pending().getReader(), 0, {
        deadline: Date.now() - 1,
      }).next(),
      /too slow/,
    );
  });

  it("rejects a response for another byte range", async () => {
    await withFetch(
      (async () =>
        new Response("{}", {
          status: 206,
          headers: { "Content-Range": "bytes 10-99/100" },
        })) as typeof fetch,
      async () => {
        await assert.rejects(
          openBackfillExport(
            { url: resultUrl, rootObjectCount: 1, fileSize: 100 },
            20,
          ),
          /another byte range/,
        );
      },
    );
  });

  it("retries a download cut off before Shopify's file size, sending nothing of it", async () => {
    const content = bytesOf(generatedExport(150));
    const size = content.length;
    const catalog = fakeCatalog(content.subarray(0, size - 50));
    await withFetch(catalog.fetcher, async () => {
      await assert.rejects(
        runCatalogImportStep(
          newJob(),
          makeContext(),
          stepGraphql({ rootObjectCount: "150", fileSize: String(size) }),
          Number.POSITIVE_INFINITY,
          async () => {},
        ),
        /cut off/,
      );
    });
    // The first segment was complete; the cut-off second one was not sent.
    assert.deepEqual(
      catalog.writes.map(({ key }) => key),
      ["shopify-backfill-789-put-0", "shopify-backfill-789-delete-0"],
    );
  });
});

type Variables = Record<string, unknown>;

const publicationResponse = (
  query: string,
  variables: Variables,
  state: ChannelState = {},
) =>
  channelResponse(
    query,
    { publication: { id: publicationId }, ...state },
    variables,
  );

describe("configureShopifyListingSource and triggerBackfill", () => {
  const validatedMetadata: ValidatedShopifyMetadata = {
    primaryLocale: "de",
    currencyCode: "EUR",
  };

  function graphqlRequest(): GraphqlRequestFn {
    return mock.fn(async (query: string, variables: Variables) =>
      query.includes("shopLocales")
        ? {
            data: {
              shopLocales: [{ locale: "de", primary: true }],
              shop: { currencyCode: "EUR" },
            },
          }
        : isChannelQuery(query)
          ? publicationResponse(query, variables)
          : {
              data: {
                bulkOperationRunQuery: {
                  bulkOperation: {
                    id: bulkOperationId,
                    status: "CREATED",
                  },
                  userErrors: [],
                },
              },
            },
    );
  }

  for (const status of [201, 204]) {
    it(`configures provider ${status} before independently submitting bulk work`, async () => {
      const catalog = catalogImports();
      const graphql = mock.fn(graphqlRequest());
      const fetchMock = mock.fn(async (input: RequestInfo | URL) => {
        assert.deepEqual(await asRequest(input).json(), {
          domain: shopDomain,
          currency: "EUR",
          language: "de",
        });
        return new Response(null, { status });
      });
      await withFetch(fetchMock as typeof fetch, async () => {
        const metadata = await configureShopifyListingSource(
          graphql,
          apiBaseUrl,
          listingSourceId,
          accessToken,
          shopDomain,
        );
        assert.deepEqual(metadata, validatedMetadata);
        assert.equal(graphql.mock.callCount(), 1);
        assert.equal(await catalog.imports.status(), null);
        assert.equal(
          await triggerBackfill(
            graphql,
            catalog.imports,
            shopDomain,
            listingSourceId,
            accessToken,
            apiBaseUrl,
            metadata,
          ),
          true,
        );
        assert.equal(fetchMock.mock.callCount(), 1);
      });
      // Metadata, the idempotent connection check, the catalog scan, the own
      // catalog's publication and export.
      assert.equal(graphql.mock.callCount(), 8);
      assert.equal((await catalog.imports.status())?.phase, "queued");
      assert.equal((await catalog.job())?.admitted, false);
      const stored = await catalog.context();
      assert.ok(stored);
      assert.equal(stored.listingSourceId, listingSourceId);
      assert.equal(stored.accessToken, accessToken);
      assert.equal(stored.bulkOperationId, bulkOperationId);
      assert.equal(stored.publicationId, publicationId);
      assert.equal(stored.currencyCode, "EUR");
      assert.equal(stored.primaryLocale, "de");
      assert.equal("shopId" in stored, false);
    });
  }

  it("refuses missing or unsupported currency before provider PUT or bulk submission", async () => {
    for (const currencyCode of [undefined, "XXX"]) {
      const graphql = mock.fn(async () => ({
        data: { shop: { currencyCode } },
      }));
      const fetchMock = mock.fn(
        async () => new Response(null, { status: 204 }),
      );
      await withFetch(fetchMock as typeof fetch, async () => {
        await assert.rejects(
          () =>
            configureShopifyListingSource(
              graphql,
              apiBaseUrl,
              listingSourceId,
              accessToken,
              shopDomain,
            ),
          /Shopify currency/,
        );
      });
      assert.equal(graphql.mock.callCount(), 1);
      assert.equal(fetchMock.mock.callCount(), 0);
    }
  });

  it("does not submit bulk work when provider configuration fails", async () => {
    const graphql = mock.fn(graphqlRequest());
    await withFetch(
      (async () => jsonResponse({ error: "Forbidden" }, 403)) as typeof fetch,
      async () => {
        await assert.rejects(() =>
          configureShopifyListingSource(
            graphql,
            apiBaseUrl,
            listingSourceId,
            accessToken,
            shopDomain,
          ),
        );
      },
    );
    assert.equal(graphql.mock.callCount(), 1);
  });

  it("submits bulk work without metadata fetch or provider PUT and does not invent locale", async () => {
    const catalog = catalogImports();
    const graphql = mock.fn(async (query: string, variables: Variables) => {
      if (isChannelQuery(query)) return publicationResponse(query, variables);
      assert.match(query, /bulkOperationRunQuery/);
      return {
        data: {
          bulkOperationRunQuery: {
            bulkOperation: {
              id: bulkOperationId,
            },
            userErrors: [],
          },
        },
      };
    });
    const fetchMock = mock.fn(async () => {
      throw new Error("Provider PUT must not happen");
    });
    await withFetch(fetchMock as typeof fetch, async () => {
      assert.equal(
        await triggerBackfill(
          graphql,
          catalog.imports,
          shopDomain,
          listingSourceId,
          accessToken,
          apiBaseUrl,
          { currencyCode: "JPY" },
        ),
        true,
      );
    });
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal(graphql.mock.callCount(), 7);
    const stored = await catalog.context();
    assert.ok(stored);
    assert.equal(stored.currencyCode, "JPY");
    assert.equal(stored.primaryLocale, undefined);
    const raw = catalog.kv.entries.get(
      `aura-historia:backfill:${shopDomain}:${(await catalog.job())?.generation}`,
    );
    assert.ok(raw);
    assert.equal("primaryLocale" in JSON.parse(raw), false);
  });

  it("records a failed bulk submission and stores no context", async () => {
    const catalog = catalogImports();
    const graphql: GraphqlRequestFn = async (query, variables) =>
      isChannelQuery(query)
        ? publicationResponse(query, variables)
        : { errors: "Already running" };
    assert.equal(
      await triggerBackfill(
        graphql,
        catalog.imports,
        shopDomain,
        listingSourceId,
        accessToken,
        apiBaseUrl,
        validatedMetadata,
      ),
      false,
    );
    assert.equal(catalog.kv.put.mock.callCount(), 0);
    assert.equal(await catalog.job(), undefined);
    const status = await catalog.imports.status();
    assert.equal(status?.phase, "failed");
    assert.equal(status?.error, "SHOPIFY_READ_FAILED");
  });

  it("starts nothing for a retired connection", async () => {
    const graphql = mock.fn(async () => {
      throw new Error("No Shopify read for a retired connection");
    });
    const status = mock.fn(async () => null);
    assert.equal(
      await triggerBackfill(
        graphql,
        {
          begin: async () => null,
          queue: mock.fn(async () => true),
          fail: mock.fn(async () => true),
          status,
        },
        shopDomain,
        listingSourceId,
        accessToken,
        apiBaseUrl,
        validatedMetadata,
      ),
      false,
    );
    assert.equal(graphql.mock.callCount(), 0);
  });

  it("discards an export whose import was stopped or replaced while it started", async () => {
    for (const stop of ["disconnect", "replacement"] as const) {
      const catalog = catalogImports();
      let newer: number | null = null;
      assert.equal(
        await triggerBackfill(
          async (query, variables) => {
            if (isChannelQuery(query))
              return publicationResponse(query, variables);
            if (stop === "disconnect") await catalog.importer.stop();
            else newer = await catalog.imports.begin();
            return {
              data: {
                bulkOperationRunQuery: {
                  bulkOperation: { id: bulkOperationId, status: "CREATED" },
                  userErrors: [],
                },
              },
            };
          },
          catalog.imports,
          shopDomain,
          listingSourceId,
          accessToken,
          apiBaseUrl,
          validatedMetadata,
        ),
        false,
      );
      assert.equal(await catalog.job(), undefined, stop);
      assert.equal(catalog.kv.entries.size, 0, stop);
      // A late completion of the discarded export admits nothing.
      await catalog.importer.start(bulkOperationId);
      assert.equal(catalog.storage.alarm, null, stop);
      // The disconnect cleared the progress; the newer import keeps its own.
      assert.deepEqual(
        (await catalog.imports.status())?.phase,
        stop === "disconnect" ? undefined : "queued",
      );
      if (newer !== null)
        assert.equal(await catalog.storage.get("generation"), newer);
    }
  });

  const refuse = (query: string, variables: Variables) =>
    query.includes("AuraChannelCreate")
      ? {
          data: {
            channelCreate: {
              channel: null,
              userErrors: [{ message: "Specification not found" }],
            },
          },
        }
      : publicationResponse(query, variables, { channel: null });
  for (const [name, respond, error] of [
    [
      "a missing read_product_listings grant",
      (query: string, variables: Variables) =>
        publicationResponse(query, variables, {
          scopes: ["read_products", "read_locales"],
        }),
      "MISSING_SCOPE",
    ],
    [
      // The exact grants of an installation approved before
      // `read_publications` was required (#392).
      "a missing read_publications grant",
      (query: string, variables: Variables) =>
        publicationResponse(query, variables, {
          scopes: [
            "read_locales",
            "read_markets",
            "read_product_listings",
            "read_products",
            "read_shipping",
          ],
        }),
      "MISSING_SCOPE",
    ],
    ["a refused channel connection", refuse, "CHANNEL_REJECTED"],
    [
      "a missing app publication",
      (query: string, variables: Variables) =>
        publicationResponse(query, variables, { publication: null }),
      "MISSING_PUBLICATION",
    ],
    [
      "a failed channel read",
      () => ({ errors: [{ message: "Throttled" }] }),
      "SHOPIFY_READ_FAILED",
    ],
    [
      "a malformed publication",
      (query: string, variables: Variables) =>
        publicationResponse(query, variables, {
          publication: { id: "gid://shopify/Channel/1" },
        }),
      "SHOPIFY_READ_FAILED",
    ],
  ] as const) {
    it(`records ${name} as retryable and never exports unfiltered products`, async () => {
      const catalog = catalogImports();
      const queries: string[] = [];
      assert.equal(
        await triggerBackfill(
          async (query, variables) => {
            queries.push(query);
            if (isChannelQuery(query)) return respond(query, variables);
            throw new Error("No bulk export without a verified publication");
          },
          catalog.imports,
          shopDomain,
          listingSourceId,
          accessToken,
          apiBaseUrl,
          validatedMetadata,
        ),
        false,
      );
      assert.ok(queries.every(isChannelQuery));
      // Missing access is detected before any publication read.
      if (error === "MISSING_SCOPE")
        assert.ok(!queries.some((query) => /AuraChannelCatalog/.test(query)));
      assert.equal(await catalog.job(), undefined);
      assert.equal(catalog.kv.entries.size, 0);
      const status = await catalog.imports.status();
      assert.equal(status?.phase, "failed");
      assert.equal(status?.error, error);
      assert.equal(status?.total, 0);
    });
  }

  it("sets up a missing channel connection before exporting its selection", async () => {
    const catalog = catalogImports();
    let channel: unknown = null;
    const writes: unknown[] = [];
    assert.equal(
      await triggerBackfill(
        async (query, variables) => {
          if (query.includes("AuraChannelCreate")) {
            writes.push(variables.input);
            channel = boundChannel();
            return { data: { channelCreate: { channel, userErrors: [] } } };
          }
          if (isChannelQuery(query))
            return publicationResponse(query, variables, { channel });
          assert.match(query, /bulkOperationRunQuery/);
          return {
            data: {
              bulkOperationRunQuery: {
                bulkOperation: { id: bulkOperationId },
                userErrors: [],
              },
            },
          };
        },
        catalog.imports,
        shopDomain,
        listingSourceId,
        accessToken,
        apiBaseUrl,
        validatedMetadata,
      ),
      true,
    );
    assert.deepEqual(writes, [
      {
        handle: "aura-historia",
        specificationHandle: "aura-historia",
        accountId: listingSourceId,
        accountName: "Aura Historia",
      },
    ]);
    assert.equal((await catalog.context())?.publicationId, publicationId);
  });
});

describe("backfill configuration", () => {
  it("declares bulk operations finish webhook in app configurations", () => {
    for (const file of [
      "shopify.app.toml",
      "shopify.app.tunnel.toml",
      "shopify.app.prod.toml",
    ]) {
      const content = readFileSync(resolve(process.cwd(), file), "utf8");
      assert.match(content, /bulk_operations\/finish/);
      assert.match(content, /webhooks\/bulk-operations\/finish/);
    }
  });

  it("requests read_locales and pins OpenAPI generation", () => {
    for (const file of ["shopify.app.toml", "shopify.app.prod.toml"]) {
      assert.match(
        readFileSync(resolve(process.cwd(), file), "utf8"),
        /read_locales/,
      );
    }
    const config = readFileSync(
      resolve(process.cwd(), "openapi-ts.config.ts"),
      "utf8",
    );
    assert.match(config, /[0-9a-f]{40}/);
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    );
    assert.ok(pkg.scripts["openapi:generate"]);
  });
});

describe("resumeCatalogImport after a scope update", () => {
  // Shopify after the merchant approved `read_publications`, and Aura
  // accepting the ingestion configuration.
  function approvedShop(scopes?: string[]) {
    const queries: string[] = [];
    const graphql: GraphqlRequestFn = async (query, variables) => {
      queries.push(query);
      if (query.includes("shopLocales"))
        return {
          data: {
            shopLocales: [{ locale: "de", primary: true }],
            shop: { currencyCode: "EUR" },
          },
        };
      if (isChannelQuery(query))
        return publicationResponse(query, variables, scopes ? { scopes } : {});
      assert.match(query, /bulkOperationRunQuery/);
      return {
        data: {
          bulkOperationRunQuery: {
            bulkOperation: { id: bulkOperationId, status: "CREATED" },
            userErrors: [],
          },
        },
      };
    };
    return { graphql, queries };
  }

  async function blocked(
    status: Omit<CatalogImportStatus, "updatedAt"> | null = {
      phase: "failed",
      total: 0,
      failed: 0,
      error: "MISSING_SCOPE",
    },
  ) {
    const catalog = catalogImports();
    if (status)
      await catalog.storage.put("status", {
        ...status,
        updatedAt: new Date().toISOString(),
      });
    return catalog;
  }

  const resume = (
    graphql: GraphqlRequestFn,
    catalog: ReturnType<typeof catalogImports>,
  ) =>
    resumeCatalogImport(
      graphql,
      catalog.imports,
      shopDomain,
      listingSourceId,
      accessToken,
      apiBaseUrl,
    );

  it("resumes an import that stopped for missing access once it is granted", async () => {
    const catalog = await blocked();
    const shopify = approvedShop();
    const fetchMock = mock.fn(async () => new Response(null, { status: 204 }));
    await withFetch(fetchMock as typeof fetch, async () => {
      assert.equal(await resume(shopify.graphql, catalog), true);
    });
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.equal((await catalog.imports.status())?.phase, "queued");
    assert.equal((await catalog.context())?.publicationId, publicationId);
  });

  it("leaves every other import state to the merchant", async () => {
    for (const status of [
      null,
      { phase: "queued", total: 0, failed: 0 },
      { phase: "submitted", total: 1, failed: 0 },
      { phase: "failed", total: 0, failed: 0, error: "SHOPIFY_READ_FAILED" },
      { phase: "failed", total: 0, failed: 0, error: "MISSING_CHANNEL" },
    ] as const) {
      const catalog = await blocked(status);
      const shopify = approvedShop();
      const fetchMock = mock.fn(
        async () => new Response(null, { status: 204 }),
      );
      await withFetch(fetchMock as typeof fetch, async () => {
        assert.equal(await resume(shopify.graphql, catalog), false);
      });
      assert.deepEqual(shopify.queries, []);
      assert.equal(fetchMock.mock.callCount(), 0);
    }
  });

  it("stays blocked while publication access is still missing", async () => {
    const catalog = await blocked();
    const shopify = approvedShop(["read_products", "read_product_listings"]);
    const fetchMock = mock.fn(async () => new Response(null, { status: 204 }));
    await withFetch(fetchMock as typeof fetch, async () => {
      assert.equal(await resume(shopify.graphql, catalog), false);
    });
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.equal((await catalog.imports.status())?.error, "MISSING_SCOPE");
  });

  it("never throws or logs the Aura token when the resume fails", async () => {
    const errors: string[] = [];
    mock.method(console, "error", (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const catalog = await blocked();
      const fetchMock = mock.fn(async () => {
        throw new Error(`Connection reset for ${accessToken}`);
      });
      await withFetch(fetchMock as typeof fetch, async () => {
        assert.equal(await resume(approvedShop().graphql, catalog), false);
      });
      assert.equal(await catalog.job(), undefined);
      assert.ok(errors.length > 0);
      assert.ok(errors.every((line) => !line.includes(accessToken)));
    } finally {
      mock.restoreAll();
    }
  });
});
