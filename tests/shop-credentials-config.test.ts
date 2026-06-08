import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  clearShopCredentials,
  getAuraHistoriaAccessTokenPreview,
  getShopCredentialsStorageKey,
  isValidAuraHistoriaAccessToken,
  isValidShopId,
  loadShopCredentials,
  saveShopCredentials,
  toPublicShopCredentialsRecord,
} from "../app/shop-credentials.server";

const appRoute = readFileSync(
  resolve(process.cwd(), "app/routes/app.tsx"),
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

  it("stores credentials per shop with the existing dedicated KV prefix", () => {
    assert.equal(
      getShopCredentialsStorageKey("example-shop.myshopify.com"),
      "aura-historia:shop-credentials:example-shop.myshopify.com",
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
    assert.equal(savedRecord.accessToken, "aurahistoria_accesstoken_abcdef123456");
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
    assert.equal(publicRecord.accessTokenPreview, "aurahistoria_accesstoken_****");
    assert.equal("accessToken" in publicRecord, false);
  });

  it("returns a safe access token preview with prefix and short key only", () => {
    assert.equal(
      getAuraHistoriaAccessTokenPreview("aurahistoria_accesstoken_foo_abcdef123456"),
      "aurahistoria_accesstoken_foo_****",
    );
    assert.equal(
      getAuraHistoriaAccessTokenPreview("aurahistoria_abcdef123456_secret"),
      "aurahistoria_abcdef123456_****",
    );
    assert.equal(getAuraHistoriaAccessTokenPreview("invalid-token"), undefined);
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

  it("marks the embedded app response as non-cacheable", () => {
    assert.match(
      appRoute,
      /headers\.set\("Cache-Control", "private, no-store"\)/,
    );
  });
});
