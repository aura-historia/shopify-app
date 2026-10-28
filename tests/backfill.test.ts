import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, mock } from "node:test";
import {
  type BackfillContext,
  type BulkJsonlProduct,
  buildBulkProductsQuery,
  buildShopifyIngestionConfiguration,
  type CatalogImportJob,
  classifyShopifyBackfillAction,
  clearBackfillContext,
  configureShopifyListingSource,
  createAdminGraphqlRequest,
  createBackfillIdempotencyKey,
  extractShopifyNumericId,
  fetchBulkOperationResult,
  fetchShopMetadata,
  type GraphqlRequestFn,
  loadBackfillContext,
  mapShopifyCurrencyCode,
  mapShopifyLocaleToLanguage,
  normalizeShopifyDomain,
  parseProductsFromJsonl,
  planBackfill,
  putShopifyIngestionConfiguration,
  requireSupportedShopifyCurrency,
  resolveLanguage,
  runCatalogImportStep,
  sendProductBatch,
  storeBackfillContext,
  submitBulkOperation,
  transformProduct,
  transformWithdrawal,
  triggerBackfill,
  type ValidatedShopifyMetadata,
} from "../app/backfill.server";
import { loadCatalogImportStatus } from "../app/catalog.server";
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

function asRequest(input: RequestInfo | URL): Request {
  return input instanceof Request ? input : new Request(input);
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
  it("parses product, image and first variant price without description HTML", () => {
    const jsonl = [
      JSON.stringify(makeProduct({ id: "gid://shopify/Product/1" })),
      '{"id":"gid://shopify/ProductImage/10","url":"https://cdn.shopify.com/1.jpg","__parentId":"gid://shopify/Product/1"}',
      '{"id":"gid://shopify/ProductVariant/10","price":"49.99","__parentId":"gid://shopify/Product/1"}',
      '{"id":"gid://shopify/ProductVariant/11","price":"50.00","__parentId":"gid://shopify/Product/1"}',
    ].join("\n");
    const { products, images, variants } = parseProductsFromJsonl(jsonl);
    assert.deepEqual(products, [
      makeProduct({ id: "gid://shopify/Product/1" }),
    ]);
    assert.deepEqual(images.get(products[0].id), [
      "https://cdn.shopify.com/1.jpg",
    ]);
    assert.equal(variants.get(products[0].id), "49.99");
  });

  it("returns empty collections for empty JSONL and initializes images for products", () => {
    const empty = parseProductsFromJsonl("");
    assert.equal(empty.products.length, 0);
    assert.equal(empty.images.size, 0);
    assert.equal(empty.variants.size, 0);
    const parsed = parseProductsFromJsonl(JSON.stringify(makeProduct()));
    assert.deepEqual(parsed.images.get(makeProduct().id), []);
  });

  it("round-trips the new required context with a TTL and supports clearing", async () => {
    const kv = makeKv();
    const context = makeContext();
    await storeBackfillContext(kv as never, shopDomain, context);
    assert.deepEqual(
      await loadBackfillContext(kv as never, shopDomain),
      context,
    );
    assert.deepEqual(kv.put.mock.calls[0].arguments[2], {
      expirationTtl: 3600,
    });
    assert.equal("shopId" in context, false);
    assert.equal("apiKey" in context, false);
    await clearBackfillContext(kv as never, shopDomain);
    assert.equal(await loadBackfillContext(kv as never, shopDomain), null);
    await storeBackfillContext(
      kv as never,
      shopDomain,
      makeContext({ primaryLocale: undefined }),
    );
    assert.equal(
      (await loadBackfillContext(kv as never, shopDomain))?.primaryLocale,
      undefined,
    );
  });

  it("returns null for absent or malformed context", async () => {
    const kv = makeKv();
    assert.equal(await loadBackfillContext(kv as never, shopDomain), null);
    kv.entries.set(`aura-historia:backfill:${shopDomain}`, "{");
    assert.equal(await loadBackfillContext(kv as never, shopDomain), null);
    kv.entries.set(
      `aura-historia:backfill:${shopDomain}`,
      JSON.stringify({
        ...makeContext(),
        listingSourceId: undefined,
        shopId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    );
    assert.equal(await loadBackfillContext(kv as never, shopDomain), null);
    kv.entries.set(
      `aura-historia:backfill:${shopDomain}`,
      JSON.stringify(makeContext({ currencyCode: "XXX" as never })),
    );
    assert.equal(await loadBackfillContext(kv as never, shopDomain), null);
    // Contexts without the snapshot's publication and time are not applied.
    for (const overrides of [
      { publicationId: undefined },
      { publicationId: "gid://shopify/Channel/1" },
    ]) {
      kv.entries.set(
        `aura-historia:backfill:${shopDomain}`,
        JSON.stringify(makeContext(overrides as never)),
      );
      assert.equal(await loadBackfillContext(kv as never, shopDomain), null);
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

  it("submits a bulk query without descriptions and returns the operation ID", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(
      async (_mutation, variables) => {
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

  it("adapts the Admin GraphQL client and fetches completed bulk URLs", async () => {
    const admin = {
      graphql: mock.fn(
        async (
          _query: string,
          options?: { variables?: Record<string, unknown> },
        ) => {
          assert.deepEqual(options?.variables, { id: bulkOperationId });
          return jsonResponse(
            {
              data: {
                node: {
                  id: bulkOperationId,
                  status: "COMPLETED",
                  url: "https://cdn.shopify.com/result.jsonl",
                },
              },
            },
            200,
          );
        },
      ),
    };
    const request = createAdminGraphqlRequest(admin);
    assert.deepEqual(await fetchBulkOperationResult(request, bulkOperationId), {
      url: "https://cdn.shopify.com/result.jsonl",
      rootObjectCount: null,
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
      { url: null, rootObjectCount: 0 },
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
  ...channel
}: { rootObjectCount?: string } & ChannelState = {}): GraphqlRequestFn {
  return async (query) =>
    isChannelQuery(query)
      ? channelResponse(query, {
          publication: { id: publicationId },
          ...channel,
        })
      : {
          data: {
            node: {
              status: "COMPLETED",
              objectCount: rootObjectCount,
              rootObjectCount,
              url: rootObjectCount === "0" ? null : resultUrl,
            },
          },
        };
}

// Fake Shopify export download plus Aura async writes.
function fakeCatalog(
  products: BulkJsonlProduct[] | string,
  respond?: (body: Array<{ sourceListingId: string }>) => Response,
) {
  const writes: Array<{ method: string; key: string | null; ids: string[] }> =
    [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const request = asRequest(input);
    if (request.url === resultUrl) {
      return new Response(
        typeof products === "string" ? products : jsonl(products),
      );
    }
    const body = (await request.json()) as Array<{ sourceListingId: string }>;
    writes.push({
      method: request.method,
      key: request.headers.get("Idempotency-Key"),
      ids: body.map((item) => item.sourceListingId),
    });
    return respond?.(body) ?? jsonResponse(report(body.length));
  }) as typeof fetch;
  return { fetcher, writes };
}

function newJob(): CatalogImportJob {
  return {
    shop: shopDomain,
    bulkOperationId,
    cursor: 0,
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

  it("plans deterministic batches of at most 100 with unique keys", () => {
    const products = Array.from({ length: 101 }, (_, index) =>
      makeProduct({
        id: `gid://shopify/Product/${index + 1}`,
        handle: `clock-${index + 1}`,
      }),
    );
    products.push(
      makeProduct({ id: "gid://shopify/Product/102", status: "ARCHIVED" }),
    );
    const plan = planBackfill(jsonl(products), 102, makeContext());
    assert.deepEqual(
      plan.batches.map(({ verb, index, items }) => [verb, index, items.length]),
      [
        ["put", 0, 100],
        ["put", 1, 1],
        ["delete", 0, 1],
      ],
    );
    assert.deepEqual(planBackfill(jsonl(products), 102, makeContext()), plan);
    assert.equal(plan.total, 102);
    assert.equal(plan.eligible, 101);
    assert.equal(plan.complete, true);
  });

  it("verifies completeness against Shopify's root object count", () => {
    const products = [makeProduct()];
    assert.equal(
      planBackfill(jsonl(products), 1, makeContext()).complete,
      true,
    );
    for (const rootObjectCount of [2, null])
      assert.equal(
        planBackfill(jsonl(products), rootObjectCount, makeContext()).complete,
        false,
      );
    // A complete empty export is a valid empty selection.
    assert.equal(planBackfill("", 0, makeContext()).complete, true);
    assert.throws(() =>
      planBackfill(
        `${JSON.stringify(makeProduct())}\n{"id":"gid://shopify/Pro`,
        2,
        makeContext(),
      ),
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
      (async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        if (request.method === "PUT") upsertBody = await request.clone().json();
        return catalog.fetcher(input);
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

  it("reports a truncated export as incomplete", async () => {
    const products = [makeProduct()];
    const catalog = fakeCatalog(products);
    await withFetch(catalog.fetcher, async () => {
      const { status } = await runToCompletion(
        products,
        stepGraphql({ rootObjectCount: "2" }),
      );
      assert.equal(status.phase, "failed");
      assert.equal(status.error, "INCOMPLETE_EXPORT");
    });
  });

  for (const [name, graphql, error] of [
    [
      "a revoked product listing scope",
      stepGraphql({ rootObjectCount: "1", scopes: ["read_products"] }),
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
        (async (input: RequestInfo | URL) => {
          if (asRequest(input).method === "PUT") now += 15_000;
          return catalog.fetcher(input);
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
        (async (input: RequestInfo | URL) => {
          const request = asRequest(input);
          // Every step spends more than its whole budget on the download.
          if (request.url === resultUrl) now += 21_000;
          if (request.method === "PUT") now += 15_000;
          return catalog.fetcher(input);
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
              if (query.includes("AuraChannelPublication"))
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

const publicationResponse = (query: string, state: ChannelState = {}) =>
  channelResponse(query, { publication: { id: publicationId }, ...state });

describe("configureShopifyListingSource and triggerBackfill", () => {
  const validatedMetadata: ValidatedShopifyMetadata = {
    primaryLocale: "de",
    currencyCode: "EUR",
  };

  function graphqlRequest(): GraphqlRequestFn {
    return mock.fn(async (query: string) =>
      query.includes("shopLocales")
        ? {
            data: {
              shopLocales: [{ locale: "de", primary: true }],
              shop: { currencyCode: "EUR" },
            },
          }
        : isChannelQuery(query)
          ? publicationResponse(query)
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
      const kv = makeKv();
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
        assert.equal(kv.put.mock.callCount(), 0);
        assert.equal(
          await triggerBackfill(
            graphql,
            kv as never,
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
      // Metadata, the idempotent connection check, publication and export.
      assert.equal(graphql.mock.callCount(), 7);
      const stored = await loadBackfillContext(kv as never, shopDomain);
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
      const kv = makeKv();
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
      assert.equal(kv.put.mock.callCount(), 0);
    }
  });

  it("does not submit bulk work when provider configuration fails", async () => {
    const kv = makeKv();
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
    assert.equal(kv.put.mock.callCount(), 0);
  });

  it("submits bulk work without metadata fetch or provider PUT and does not invent locale", async () => {
    const kv = makeKv();
    const graphql = mock.fn(async (query: string) => {
      if (isChannelQuery(query)) return publicationResponse(query);
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
          kv as never,
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
    assert.equal(graphql.mock.callCount(), 6);
    const stored = await loadBackfillContext(kv as never, shopDomain);
    assert.ok(stored);
    assert.equal(stored.currencyCode, "JPY");
    assert.equal(stored.primaryLocale, undefined);
    const raw = kv.entries.get(`aura-historia:backfill:${shopDomain}`);
    assert.ok(raw);
    assert.equal("primaryLocale" in JSON.parse(raw), false);
  });

  it("does not store context if bulk submission fails", async () => {
    const kv = makeKv();
    const graphql: GraphqlRequestFn = async (query) =>
      isChannelQuery(query)
        ? publicationResponse(query)
        : { errors: "Already running" };
    assert.equal(
      await triggerBackfill(
        graphql,
        kv as never,
        shopDomain,
        listingSourceId,
        accessToken,
        apiBaseUrl,
        validatedMetadata,
      ),
      false,
    );
    assert.equal(kv.put.mock.callCount(), 0);
  });

  it("keeps an accepted export usable when optional progress writes fail", async () => {
    const kv = makeKv();
    const put = kv.put;
    let statusWrites = 0;
    kv.put = mock.fn(async (key, value, options) => {
      if (key.startsWith("aura-historia:catalog-status:")) {
        statusWrites++;
        throw new Error("KV unavailable");
      }
      await put(key, value, options);
    });
    assert.equal(
      await triggerBackfill(
        async (query) =>
          isChannelQuery(query)
            ? publicationResponse(query)
            : {
                data: {
                  bulkOperationRunQuery: {
                    bulkOperation: {
                      id: bulkOperationId,
                      status: "CREATED",
                    },
                  },
                },
              },
        kv,
        shopDomain,
        listingSourceId,
        accessToken,
        apiBaseUrl,
        validatedMetadata,
      ),
      true,
    );
    assert.equal(statusWrites, 3);
    assert.equal(
      (await loadBackfillContext(kv, shopDomain))?.bulkOperationId,
      bulkOperationId,
    );
  });

  const refuse = (query: string) =>
    query.includes("AuraChannelCreate")
      ? {
          data: {
            channelCreate: {
              channel: null,
              userErrors: [{ message: "Requires online store parity" }],
            },
          },
        }
      : publicationResponse(query, { channel: null });
  for (const [name, respond, error] of [
    [
      "a missing read_product_listings grant",
      (query: string) =>
        publicationResponse(query, {
          scopes: ["read_products", "read_locales"],
        }),
      "MISSING_SCOPE",
    ],
    ["a refused channel connection", refuse, "CHANNEL_REJECTED"],
    [
      "a missing app publication",
      (query: string) => publicationResponse(query, { publication: null }),
      "MISSING_PUBLICATION",
    ],
    [
      "a failed channel read",
      () => ({ errors: [{ message: "Throttled" }] }),
      "SHOPIFY_READ_FAILED",
    ],
    [
      "a malformed publication",
      (query: string) =>
        publicationResponse(query, {
          publication: { id: "gid://shopify/Channel/1" },
        }),
      "SHOPIFY_READ_FAILED",
    ],
  ] as const) {
    it(`records ${name} as retryable and never exports unfiltered products`, async () => {
      const kv = makeKv();
      const queries: string[] = [];
      assert.equal(
        await triggerBackfill(
          async (query) => {
            queries.push(query);
            if (isChannelQuery(query)) return respond(query);
            throw new Error("No bulk export without a verified publication");
          },
          kv as never,
          shopDomain,
          listingSourceId,
          accessToken,
          apiBaseUrl,
          validatedMetadata,
        ),
        false,
      );
      assert.ok(queries.every(isChannelQuery));
      assert.equal(await loadBackfillContext(kv as never, shopDomain), null);
      const status = await loadCatalogImportStatus(kv as never, shopDomain);
      assert.equal(status?.phase, "failed");
      assert.equal(status?.error, error);
      assert.equal(status?.total, 0);
    });
  }

  it("sets up a missing channel connection before exporting its selection", async () => {
    const kv = makeKv();
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
            return publicationResponse(query, { channel });
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
        kv as never,
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
    assert.equal(
      (await loadBackfillContext(kv as never, shopDomain))?.publicationId,
      publicationId,
    );
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
