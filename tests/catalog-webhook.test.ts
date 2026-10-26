import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, mock } from "node:test";
import { storeBackfillContext } from "../app/backfill.server";
import { loadCatalogImportStatus } from "../app/catalog.server";
import { action } from "../app/routes/webhooks.bulk-operations.finish";

describe("catalog completion webhook", () => {
  it("acknowledges Shopify before saving progress and processes an empty export", async () => {
    const shop = "example.myshopify.com";
    const bulkOperationId = "gid://shopify/BulkOperation/123";
    const entries = new Map<string, string>();
    let releaseProgress = () => {};
    const pendingProgress = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    const kv = {
      get: async (key: string) => entries.get(key) ?? null,
      put: async (key: string, value: string) => {
        if (JSON.parse(value).phase === "processing") await pendingProgress;
        entries.set(key, value);
      },
      delete: async (key: string) => {
        entries.delete(key);
      },
    };
    await storeBackfillContext(kv, shop, {
      listingSourceId: `ls_${"0".repeat(26)}`,
      accessToken: "synthetic-aura-token",
      apiBaseUrl: "https://aura.invalid",
      currencyCode: "EUR",
      shopDomain: shop,
      bulkOperationId,
      createdAt: new Date().toISOString(),
    });
    const graphql = mock.fn(async () => ({
      data: {
        node: {
          status: "COMPLETED",
          objectCount: "0",
          url: null,
        },
      },
    }));
    const work: Promise<unknown>[] = [];
    const body = JSON.stringify({
      type: "query",
      status: "completed",
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
    assert.equal(response.status, 200);
    assert.equal(work.length, 1);
    assert.equal(graphql.mock.callCount(), 0);

    releaseProgress();
    await Promise.all(work);
    assert.equal(graphql.mock.callCount(), 1);
    const status = await loadCatalogImportStatus(kv as never, shop);
    assert.equal(status?.phase, "submitted");
    assert.equal(status?.total, 0);
    assert.equal(entries.has(`aura-historia:backfill:${shop}`), false);
  });
});
