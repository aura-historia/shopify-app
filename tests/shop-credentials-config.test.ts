import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  clearShopCredentials,
  clearShopCredentialsDisconnected,
  getShopCredentialsDisconnectedStorageKey,
  getShopCredentialsStorageKey,
  isShopCredentialsDisconnected,
  isValidAuraHistoriaAccessToken,
  isValidShopId,
  loadShopCredentials,
  markShopCredentialsDisconnected,
  saveShopCredentials,
  toPublicShopCredentialsRecord,
} from "../app/shop-credentials.server";

const appRoute = readFileSync(
  resolve(process.cwd(), "app/routes/app.tsx"),
  "utf8",
);
const uninstallWebhookRoute = readFileSync(
  resolve(process.cwd(), "app/routes/webhooks.app.uninstalled.tsx"),
  "utf8",
);

describe("shop OAuth credentials configuration", () => {
  it("validates the expected shop ID and access token formats", () => {
    const validShopId = randomUUID();
    const validAccessToken = "aurahistoria_accesstoken_1234567890abcdef";
    const validMultiSegmentAccessToken =
      "aurahistoria_accesstoken_access_1234567890abcdef";

    assert.equal(isValidShopId(validShopId), true);
    assert.equal(isValidShopId("not-a-uuid"), false);
    assert.equal(isValidAuraHistoriaAccessToken(validAccessToken), true);
    assert.equal(
      isValidAuraHistoriaAccessToken(validMultiSegmentAccessToken),
      true,
    );
    assert.equal(
      isValidAuraHistoriaAccessToken("aurahistoria_missingtail"),
      false,
    );
  });

  it("stores credentials and disconnect markers per shop with dedicated KV prefixes", () => {
    assert.equal(
      getShopCredentialsStorageKey("example-shop.myshopify.com"),
      "aura-historia:shop-credentials:example-shop.myshopify.com",
    );
    assert.equal(
      getShopCredentialsDisconnectedStorageKey("example-shop.myshopify.com"),
      "aura-historia:shop-credentials-disconnected:example-shop.myshopify.com",
    );
  });

  it("round-trips OAuth credentials through Cloudflare KV", async () => {
    const entries = new Map<string, string>();
    const kv = {
      get: async (key: string) => entries.get(key) ?? null,
      put: async (key: string, value: string) => {
        entries.set(key, value);
      },
    };

    await saveShopCredentials(kv as never, "example-shop.myshopify.com", {
      shopId: randomUUID(),
      accessToken: "aurahistoria_accesstoken_abcdef123456",
      scope: "products:write",
      shopifyStoreName: "example-shop",
    });

    const savedRecord = await loadShopCredentials(
      kv as never,
      "example-shop.myshopify.com",
    );

    assert.ok(savedRecord);
    assert.match(savedRecord.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(
      savedRecord.accessToken,
      "aurahistoria_accesstoken_abcdef123456",
    );
    assert.equal(savedRecord.tokenType, "BEARER");
    assert.equal(savedRecord.scope, "products:write");
    assert.equal(savedRecord.shopifyStoreName, "example-shop");
  });

  it("keeps the stored access token out of public loader data", async () => {
    const publicRecord = toPublicShopCredentialsRecord({
      shopId: randomUUID(),
      accessToken: "aurahistoria_accesstoken_abcdef123456",
      tokenType: "BEARER",
      scope: "products:write",
      shopifyStoreName: "example-shop",
      updatedAt: "2026-06-06T00:00:00.000Z",
    });

    assert.equal(publicRecord.hasAccessToken, true);
    assert.equal("accessToken" in publicRecord, false);
    assert.equal("accessTokenPreview" in publicRecord, false);
  });

  it("clears stored credentials for disconnect", async () => {
    const entries = new Map<string, string>();
    const kv = {
      get: async (key: string) => entries.get(key) ?? null,
      put: async (key: string, value: string) => {
        entries.set(key, value);
      },
      delete: async (key: string) => {
        entries.delete(key);
      },
    };

    await saveShopCredentials(kv as never, "example-shop.myshopify.com", {
      shopId: randomUUID(),
      accessToken: "aurahistoria_accesstoken_abcdef123456",
    });

    await clearShopCredentials(kv as never, "example-shop.myshopify.com");

    assert.equal(
      await loadShopCredentials(kv as never, "example-shop.myshopify.com"),
      null,
    );
  });

  it("persists and clears intentional disconnect state", async () => {
    const entries = new Map<string, string>();
    const kv = {
      get: async (key: string) => entries.get(key) ?? null,
      put: async (key: string, value: string) => {
        entries.set(key, value);
      },
      delete: async (key: string) => {
        entries.delete(key);
      },
    };

    assert.equal(
      await isShopCredentialsDisconnected(
        kv as never,
        "example-shop.myshopify.com",
      ),
      false,
    );

    await markShopCredentialsDisconnected(
      kv as never,
      "example-shop.myshopify.com",
    );

    assert.equal(
      await isShopCredentialsDisconnected(
        kv as never,
        "example-shop.myshopify.com",
      ),
      true,
    );

    await clearShopCredentialsDisconnected(
      kv as never,
      "example-shop.myshopify.com",
    );

    assert.equal(
      await isShopCredentialsDisconnected(
        kv as never,
        "example-shop.myshopify.com",
      ),
      false,
    );
  });

  it("can read pre-OAuth records that used the apiKey field", async () => {
    const entries = new Map<string, string>();
    const kv = {
      get: async (key: string) => entries.get(key) ?? null,
      put: async (key: string, value: string) => {
        entries.set(key, value);
      },
    };

    entries.set(
      getShopCredentialsStorageKey("example-shop.myshopify.com"),
      JSON.stringify({
        shopId: randomUUID(),
        apiKey: "aurahistoria_accesstoken_legacy",
        updatedAt: "2026-06-06T00:00:00.000Z",
      }),
    );

    const savedRecord = await loadShopCredentials(
      kv as never,
      "example-shop.myshopify.com",
    );

    assert.ok(savedRecord);
    assert.equal(savedRecord.accessToken, "aurahistoria_accesstoken_legacy");
    assert.equal(savedRecord.tokenType, "BEARER");
  });

  it("clears app-owned Aura Historia connection data on uninstall", () => {
    assert.ok(uninstallWebhookRoute.includes("loadShopCredentials"));
    assert.ok(uninstallWebhookRoute.includes("revokeAuraHistoriaAccessToken"));
    assert.ok(uninstallWebhookRoute.includes("clearShopCredentials"));
    assert.ok(
      uninstallWebhookRoute.includes("clearShopCredentialsDisconnected"),
    );
    assert.ok(uninstallWebhookRoute.includes("clearBackfillContext"));
    assert.ok(uninstallWebhookRoute.includes("clearedAuraHistoriaCredentials"));
  });

  it("marks the embedded app response as non-cacheable", () => {
    assert.match(
      appRoute,
      /headers\.set\("Cache-Control", "private, no-store"\)/,
    );
  });
});
