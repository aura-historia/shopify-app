import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, mock } from "node:test";
import { storeBackfillContext } from "../app/backfill.server";
import { loadCatalogImportStatus } from "../app/catalog.server";
import { action } from "../app/routes/webhooks.bulk-operations.finish";

const shop = "example.myshopify.com";
const bulkOperationId = "gid://shopify/BulkOperation/123";
const publicationId = "gid://shopify/Publication/456";

function makeKv(beforePut?: (value: string) => Promise<void>) {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => {
      await beforePut?.(value);
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
  };
}

function publication(
  id: string | null = publicationId,
  scopes = ["read_products", "read_product_listings"],
) {
  return {
    data: {
      currentAppInstallation: {
        accessScopes: scopes.map((handle) => ({ handle })),
        publication: id && { id },
      },
    },
  };
}

function shopifyGraphql(publicationResponse = publication()) {
  return mock.fn(async (_shop: string, query: string) =>
    query.includes("AuraChannelPublication")
      ? publicationResponse
      : {
          data: {
            node: {
              status: "COMPLETED",
              objectCount: "0",
              rootObjectCount: "0",
              url: null,
            },
          },
        },
  );
}

async function deliver(
  kv: ReturnType<typeof makeKv>,
  graphql: ReturnType<typeof shopifyGraphql>,
  status = "completed",
) {
  await storeBackfillContext(kv, shop, {
    listingSourceId: `ls_${"0".repeat(26)}`,
    accessToken: "synthetic-aura-token",
    apiBaseUrl: "https://aura.invalid",
    currencyCode: "EUR",
    shopDomain: shop,
    bulkOperationId,
    publicationId,
    snapshotStartedAt: "2026-10-27T10:00:00.000Z",
    createdAt: new Date().toISOString(),
  });
  const work: Promise<unknown>[] = [];
  const body = JSON.stringify({
    type: "query",
    status,
    admin_graphql_api_id: bulkOperationId,
  });
  const response = await action({
    request: new Request(
      "https://app.invalid/webhooks/bulk-operations/finish",
      {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": "bulk_operations/finish",
          "X-Shopify-Shop-Domain": shop,
          "X-Shopify-API-Version": "2026-10",
          "X-Shopify-Webhook-Id": crypto.randomUUID(),
          "X-Shopify-Hmac-Sha256": createHmac("sha256", "synthetic-secret")
            .update(body)
            .digest("base64"),
        },
      },
    ),
    context: {
      cloudflare: {
        env: {
          KV: kv,
          SHOPIFY_API_KEY: "synthetic-key",
          SHOPIFY_API_SECRET: "synthetic-secret",
          SHOPIFY_APP_URL: "https://app.invalid",
          SHOP_COORDINATOR: { getByName: () => ({ graphql }) },
        },
        ctx: { waitUntil: (promise: Promise<unknown>) => work.push(promise) },
      },
    },
    params: {},
  } as never);
  return { response, work };
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

describe("catalog completion webhook", () => {
  it("acknowledges Shopify before saving progress and reconciles an empty export", async () => {
    let releaseProgress = () => {};
    const pendingProgress = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    const kv = makeKv(async (value) => {
      if (JSON.parse(value).phase === "processing") await pendingProgress;
    });
    const graphql = shopifyGraphql();
    const auraRequests: Request[] = [];
    await withFetch(
      (async (input: RequestInfo | URL) => {
        auraRequests.push(new Request(input));
        return Response.json({ items: [], size: 0 });
      }) as typeof fetch,
      async () => {
        const { response, work } = await deliver(kv, graphql);
        assert.equal(response.status, 200);
        assert.equal(work.length, 1);
        assert.equal(graphql.mock.callCount(), 0);

        releaseProgress();
        await Promise.all(work);
      },
    );
    assert.equal(graphql.mock.callCount(), 2);
    // A complete empty selection still reads the source for absent records.
    assert.deepEqual(
      auraRequests.map((request) => request.method),
      ["GET"],
    );
    const status = await loadCatalogImportStatus(kv as never, shop);
    assert.equal(status?.phase, "submitted");
    assert.equal(status?.total, 0);
    assert.equal(status?.eligible, 0);
    assert.equal(status?.reconciled, true);
    assert.equal(kv.entries.has(`aura-historia:backfill:${shop}`), false);
  });

  for (const [name, response, error] of [
    [
      "a replaced channel publication",
      publication("gid://shopify/Publication/789"),
      "PUBLICATION_CHANGED",
    ],
    [
      "a revoked product listing scope",
      publication(publicationId, ["read_products"]),
      "MISSING_SCOPE",
    ],
    ["a removed channel publication", publication(null), "MISSING_PUBLICATION"],
  ] as const) {
    it(`discards the snapshot without writes after ${name}`, async () => {
      const kv = makeKv();
      const fetcher = mock.fn(async () => Response.json({}));
      await withFetch(fetcher as typeof fetch, async () => {
        const { work } = await deliver(kv, shopifyGraphql(response));
        await Promise.all(work);
      });
      assert.equal(fetcher.mock.callCount(), 0);
      const status = await loadCatalogImportStatus(kv as never, shop);
      assert.equal(status?.phase, "failed");
      assert.equal(status?.error, error);
      assert.equal(kv.entries.has(`aura-historia:backfill:${shop}`), false);
    });
  }

  it("records a failed Shopify export as a retryable read failure", async () => {
    const kv = makeKv();
    const graphql = shopifyGraphql();
    const { work } = await deliver(kv, graphql, "failed");
    assert.equal(work.length, 0);
    assert.equal(graphql.mock.callCount(), 0);
    const status = await loadCatalogImportStatus(kv as never, shop);
    assert.equal(status?.phase, "failed");
    assert.equal(status?.error, "SHOPIFY_READ_FAILED");
  });
});
