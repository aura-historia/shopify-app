import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, mock } from "node:test";
import { storeBackfillContext } from "../app/backfill.server";
import { loadCatalogImportStatus } from "../app/catalog.server";
import { action } from "../app/routes/webhooks.bulk-operations.finish";

const shop = "example.myshopify.com";
const bulkOperationId = "gid://shopify/BulkOperation/123";

function makeKv() {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
  };
}

async function deliver(
  start: (shop: string, bulkOperationId: string) => Promise<void>,
  {
    status = "completed",
    operation = bulkOperationId,
    topic = "bulk_operations/finish",
    payload = undefined as unknown,
  } = {},
) {
  const kv = makeKv();
  await storeBackfillContext(kv, shop, {
    listingSourceId: `ls_${"0".repeat(26)}`,
    accessToken: "synthetic-aura-token",
    apiBaseUrl: "https://aura.invalid",
    currencyCode: "EUR",
    shopDomain: shop,
    bulkOperationId,
    publicationId: "gid://shopify/Publication/456",
    createdAt: new Date().toISOString(),
  });
  const body = JSON.stringify(
    payload === undefined
      ? {
          type: "query",
          status,
          admin_graphql_api_id: operation,
        }
      : payload,
  );
  const getByName = mock.fn(() => ({ start }));
  const response = await action({
    request: new Request(
      "https://app.invalid/webhooks/bulk-operations/finish",
      {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": topic,
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
          CATALOG_IMPORTER: { getByName },
        },
        ctx: {
          waitUntil: () => {
            throw new Error("Processing must not run in waitUntil");
          },
        },
      },
    },
    params: {},
  } as never);
  return { response, kv, getByName };
}

describe("catalog completion webhook", () => {
  it("rejects another signed topic and malformed bodies without admitting work", async () => {
    for (const options of [
      { topic: "app/uninstalled" },
      { payload: null },
      { payload: [] },
    ]) {
      const start = mock.fn(async () => {});
      const { response, kv } = await deliver(start, options);
      assert.equal(response.status, 400);
      assert.equal(start.mock.callCount(), 0);
      assert.ok(kv.entries.has(`aura-historia:backfill:${shop}`));
    }
  });
  it("durably admits the matching export to the shop's catalog importer", async () => {
    const start = mock.fn(async () => {});
    const { response, kv, getByName } = await deliver(start);
    assert.equal(response.status, 200);
    assert.deepEqual(getByName.mock.calls[0].arguments, [shop]);
    assert.deepEqual(start.mock.calls[0].arguments, [shop, bulkOperationId]);
    // The importer owns the context until the import finishes.
    assert.ok(kv.entries.has(`aura-historia:backfill:${shop}`));
  });

  it("asks Shopify to retry when admission cannot be committed", async () => {
    const { response, kv } = await deliver(async () => {
      throw new Error("Durable Object unavailable");
    });
    assert.equal(response.status, 503);
    assert.ok(kv.entries.has(`aura-historia:backfill:${shop}`));
  });

  it("ignores exports that are not the shop's current import", async () => {
    const start = mock.fn(async () => {});
    const { response } = await deliver(start, {
      operation: "gid://shopify/BulkOperation/999",
    });
    assert.equal(response.status, 200);
    assert.equal(start.mock.callCount(), 0);
  });

  it("records a failed Shopify export as a retryable read failure", async () => {
    const start = mock.fn(async () => {});
    const { kv } = await deliver(start, { status: "failed" });
    assert.equal(start.mock.callCount(), 0);
    const status = await loadCatalogImportStatus(kv as never, shop);
    assert.equal(status?.phase, "failed");
    assert.equal(status?.error, "SHOPIFY_READ_FAILED");
    assert.equal(kv.entries.has(`aura-historia:backfill:${shop}`), false);
  });
});
