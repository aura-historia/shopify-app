import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, describe, it, mock } from "node:test";
import { action } from "../app/routes/webhooks.app.uninstalled";
import { getShopifyWebhook } from "../app/shopify.server";

const shop = "uninstall.myshopify.com";
const secret = "synthetic-webhook-secret";

function runtime() {
  const disconnectShipping = mock.fn(async () => {});
  const context = {
    cloudflare: {
      env: {
        KV: { get: async () => null, delete: mock.fn(async () => {}) },
        SHOPIFY_API_KEY: "synthetic-key",
        SHOPIFY_API_SECRET: secret,
        SHOPIFY_APP_URL: "https://app.invalid",
        SHOP_COORDINATOR: { getByName: () => ({ disconnectShipping }) },
      },
    },
  };
  const storage = getShopifyWebhook(context as never).sessionStorage;
  const deliver = async (topic = "app/uninstalled") => {
    const body = "{}";
    return action({
      request: new Request("https://app.invalid/webhooks/app/uninstalled", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": topic,
          "X-Shopify-Shop-Domain": shop,
          "X-Shopify-API-Version": "2026-10",
          "X-Shopify-Webhook-Id": crypto.randomUUID(),
          "X-Shopify-Hmac-Sha256": createHmac("sha256", secret)
            .update(body)
            .digest("base64"),
        },
      }),
      context,
      params: {},
    } as never);
  };
  return { context, storage, deliver, disconnectShipping };
}

describe("uninstall webhook", () => {
  afterEach(() => mock.restoreAll());

  it("tolerates missing and duplicate indexed sessions on redelivery", async () => {
    const { storage, deliver, disconnectShipping } = runtime();
    const id = `offline_${shop}`;
    mock.method(storage, "findSessionsByShop", async () => [
      undefined,
      { id },
      { id },
    ]);
    const deleted = mock.method(storage, "deleteSessions", async () => true);
    assert.equal((await deliver()).status, 200);
    assert.deepEqual(deleted.mock.calls[0].arguments, [[id]]);
    assert.deepEqual(disconnectShipping.mock.calls[0].arguments, [shop, true]);
  });

  it("asks Shopify to retry when session deletion reports failure", async () => {
    const { storage, deliver } = runtime();
    mock.method(storage, "findSessionsByShop", async () => []);
    mock.method(storage, "deleteSessions", async () => false);
    assert.equal((await deliver()).status, 503);
  });

  it("rejects another signed topic before touching connection data", async () => {
    const { context, deliver, disconnectShipping } = runtime();
    assert.equal((await deliver("bulk_operations/finish")).status, 400);
    assert.equal(disconnectShipping.mock.callCount(), 0);
    assert.equal(context.cloudflare.env.KV.delete.mock.callCount(), 0);
  });
});
