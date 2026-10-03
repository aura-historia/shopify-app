import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, mock } from "node:test";
import {
  type BackfillContext,
  type BulkJsonlProduct,
  buildShopifyIngestionConfiguration,
  clearBackfillContext,
  createAdminGraphqlRequest,
  createBackfillIdempotencyKey,
  extractShopifyNumericId,
  fetchBulkOperationResultUrl,
  fetchShopMetadata,
  type GraphqlRequestFn,
  loadBackfillContext,
  mapShopifyCurrencyCode,
  mapShopifyLocaleToLanguage,
  normalizeShopifyDomain,
  parseProductsFromJsonl,
  processBackfillResults,
  putShopifyIngestionConfiguration,
  resolveLanguage,
  sendProductBatch,
  storeBackfillContext,
  submitBulkOperation,
  transformProduct,
  transformWithdrawal,
  triggerBackfill,
} from "../app/backfill.server";

const listingSourceId = `ls_${"0".repeat(26)}`;
const apiBaseUrl = "https://api.test.com";
const shopDomain = "my-shop.myshopify.com";
const accessToken = "aurahistoria_accesstoken_test";
const bulkOperationId = "gid://shopify/BulkOperation/789";

function makeProduct(
  overrides: Partial<BulkJsonlProduct> = {},
): BulkJsonlProduct {
  return {
    id: "gid://shopify/Product/12345",
    title: "Antique Clock",
    status: "ACTIVE",
    totalInventory: 5,
    onlineStoreUrl: `https://${shopDomain}/products/antique-clock`,
    handle: "antique-clock",
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
    assert.equal(mapShopifyCurrencyCode("SEK"), undefined);
    assert.equal(mapShopifyCurrencyCode(undefined), undefined);
    assert.equal(normalizeShopifyDomain(" My-Shop.MyShopify.com "), shopDomain);
    assert.equal(normalizeShopifyDomain("  "), undefined);
  });

  it("always configures the normalized domain and only known currency/language", () => {
    assert.deepEqual(
      buildShopifyIngestionConfiguration(
        { primaryLocale: "de-AT", currencyCode: "EUR" },
        " My-Shop.MyShopify.com ",
      ),
      { domain: shopDomain, currency: "EUR", language: "de" },
    );
    assert.deepEqual(
      buildShopifyIngestionConfiguration(
        { primaryLocale: "sv-SE", currencyCode: "SEK" },
        shopDomain,
      ),
      { domain: shopDomain },
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
      transformProduct(makeProduct(), [], "10.00", "en", "SEK", shopDomain)
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
      makeProduct({ totalInventory: null }),
      [],
      null,
      "en",
      "EUR",
      shopDomain,
    );
    assert.equal(available.availability, "IN_STOCK");
    assert.equal(soldOut.availability, "OUT_OF_STOCK");
    assert.equal(untracked.availability, null);
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
    assert.equal(await submitBulkOperation(graphqlRequest), bulkOperationId);
    await assert.rejects(
      () =>
        submitBulkOperation(async () => ({
          data: {
            bulkOperationRunQuery: {
              bulkOperation: null,
              userErrors: [{ message: "Already running" }],
            },
          },
        })),
      /Already running/,
    );
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
    assert.equal(
      await fetchBulkOperationResultUrl(request, bulkOperationId),
      "https://cdn.shopify.com/result.jsonl",
    );
    await assert.rejects(
      () =>
        fetchBulkOperationResultUrl(
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
          `${apiBaseUrl}/api/v1/listing-sources/${listingSourceId}/ingestion-configurations/shopify`,
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

  it("sends only the required domain for unsupported locale and currency", async () => {
    await withFetch(
      (async (input: RequestInfo | URL) => {
        assert.deepEqual(await asRequest(input).json(), { domain: shopDomain });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      async () => {
        await putShopifyIngestionConfiguration(
          apiBaseUrl,
          listingSourceId,
          accessToken,
          { primaryLocale: "sv", currencyCode: "SEK" },
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
            {},
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
          `${apiBaseUrl}/api/v1/listing-sources/${listingSourceId}/product-listings/async`,
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

describe("processing bulk results", () => {
  it("routes active products to PUT, inactive products to DELETE, and keeps batches <= 100", async () => {
    const products = Array.from({ length: 101 }, (_, index) =>
      makeProduct({
        id: `gid://shopify/Product/${index + 1}`,
        handle: `clock-${index + 1}`,
      }),
    );
    products.push(
      makeProduct({ id: "gid://shopify/Product/102", status: "ARCHIVED" }),
    );
    const requests: Array<{
      verb: string;
      key: string | null;
      body: Array<{ sourceListingId: string }>;
    }> = [];
    await withFetch(
      (async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        if (request.url === "https://cdn.shopify.com/result.jsonl") {
          return new Response(
            products.map((product) => JSON.stringify(product)).join("\n"),
          );
        }
        const body = (await request.json()) as Array<{
          sourceListingId: string;
        }>;
        requests.push({
          verb: request.method.toLowerCase(),
          key: request.headers.get("Idempotency-Key"),
          body,
        });
        return jsonResponse(report(body.length));
      }) as typeof fetch,
      async () => {
        assert.deepEqual(
          await processBackfillResults(
            "https://cdn.shopify.com/result.jsonl",
            makeContext(),
          ),
          { total: 102, failures: [] },
        );
      },
    );
    const puts = requests.filter((request) => request.verb === "put");
    const deletes = requests.filter((request) => request.verb === "delete");
    assert.equal(
      puts.reduce((total, request) => total + request.body.length, 0),
      101,
    );
    assert.equal(
      deletes.reduce((total, request) => total + request.body.length, 0),
      1,
    );
    assert.ok(requests.every((request) => request.body.length <= 100));
    assert.deepEqual(deletes[0].body, [{ sourceListingId: "102" }]);
    assert.ok(requests.every((request) => request.key));
    assert.equal(
      new Set(requests.map((request) => request.key)).size,
      requests.length,
    );
  });

  it("returns reported failures rather than silently treating admission as success", async () => {
    const jsonl = [
      makeProduct(),
      makeProduct({ id: "gid://shopify/Product/6", status: "DRAFT" }),
    ]
      .map((product) => JSON.stringify(product))
      .join("\n");
    await withFetch(
      (async (input: RequestInfo | URL) => {
        const request = asRequest(input);
        if (request.url.endsWith(".jsonl")) return new Response(jsonl);
        const body = (await request.json()) as Array<{
          sourceListingId: string;
        }>;
        return jsonResponse(
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
        );
      }) as typeof fetch,
      async () => {
        assert.deepEqual(
          await processBackfillResults(
            "https://cdn.shopify.com/result.jsonl",
            makeContext(),
          ),
          { total: 2, failures: ["12345", "6"] },
        );
      },
    );
  });
});

describe("triggerBackfill", () => {
  function graphqlRequest(): GraphqlRequestFn {
    return mock.fn(async (query: string) =>
      query.includes("shopLocales")
        ? {
            data: {
              shopLocales: [{ locale: "de", primary: true }],
              shop: { currencyCode: "EUR" },
            },
          }
        : {
            data: {
              bulkOperationRunQuery: {
                bulkOperation: { id: bulkOperationId, status: "CREATED" },
                userErrors: [],
              },
            },
          },
    );
  }

  for (const status of [201, 204]) {
    it(`stores context and submits bulk work after provider ${status}`, async () => {
      const kv = makeKv();
      await withFetch(
        (async () => new Response(null, { status })) as typeof fetch,
        async () => {
          assert.equal(
            await triggerBackfill(
              graphqlRequest(),
              kv as never,
              shopDomain,
              listingSourceId,
              accessToken,
              apiBaseUrl,
            ),
            true,
          );
        },
      );
      const stored = await loadBackfillContext(kv as never, shopDomain);
      assert.ok(stored);
      assert.equal(stored.listingSourceId, listingSourceId);
      assert.equal(stored.accessToken, accessToken);
      assert.equal(stored.bulkOperationId, bulkOperationId);
      assert.equal("shopId" in stored, false);
    });
  }

  it("does not submit the bulk operation or store context when provider configuration fails", async () => {
    const kv = makeKv();
    const graphql = mock.fn(graphqlRequest());
    await withFetch(
      (async () => jsonResponse({ error: "Forbidden" }, 403)) as typeof fetch,
      async () => {
        assert.equal(
          await triggerBackfill(
            graphql,
            kv as never,
            shopDomain,
            listingSourceId,
            accessToken,
            apiBaseUrl,
          ),
          false,
        );
      },
    );
    assert.equal(graphql.mock.callCount(), 1);
    assert.equal(kv.put.mock.callCount(), 0);
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
