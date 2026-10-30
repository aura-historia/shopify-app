import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  clearShopCredentials,
  clearShopCredentialsDisconnected,
  getShopCredentialsDisconnectedStorageKey,
  getShopCredentialsStorageKey,
  isShopCredentialsDisconnected,
  isValidListingSourceId,
  loadShopCredentials,
  markShopCredentialsDisconnected,
  saveShopCredentials,
  toPublicShopCredentialsRecord,
} from "../app/shop-credentials.server";

const listingSourceId = `ls_${"0".repeat(26)}`;

const appRoute = readFileSync(
  resolve(process.cwd(), "app/routes/app.tsx"),
  "utf8",
);
const uninstallWebhookRoute = readFileSync(
  resolve(process.cwd(), "app/routes/webhooks.app.uninstalled.tsx"),
  "utf8",
);

describe("shop OAuth credentials configuration", () => {
  it("validates canonical listing source TypeIDs", () => {
    assert.equal(isValidListingSourceId(listingSourceId), true);
    assert.equal(isValidListingSourceId(`ls_7${"v".repeat(25)}`), true);
    for (const invalid of [
      "not-a-uuid",
      `ls_8${"0".repeat(25)}`,
      `ls_${"0".repeat(25)}`,
      `ls_${"0".repeat(27)}`,
      `ls_0${"i".repeat(25)}`,
      `LS_${"0".repeat(26)}`,
      `ls_0${"O".repeat(25)}`,
    ]) {
      assert.equal(isValidListingSourceId(invalid), false, invalid);
    }
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
      listingSourceId,
      accessToken: "aurahistoria_accesstoken_abcdef123456",
      scope: "listing-sources:write product-listings:write",
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
    assert.ok(savedRecord.connectionId);
    assert.equal(
      savedRecord.scope,
      "listing-sources:write product-listings:write",
    );
    assert.equal(savedRecord.listingSourceId, listingSourceId);
    assert.equal(savedRecord.shopifyStoreName, "example-shop");
  });

  it("keeps the stored access token out of public loader data", async () => {
    const publicRecord = toPublicShopCredentialsRecord({
      listingSourceId,
      accessToken: "aurahistoria_accesstoken_abcdef123456",
      tokenType: "BEARER",
      scope: "listing-sources:write product-listings:write",
      shopifyStoreName: "example-shop",
      updatedAt: "2026-06-06T00:00:00.000Z",
      connectionId: "fixture-connection",
    });

    assert.equal(publicRecord.hasAccessToken, true);
    assert.equal(publicRecord.listingSourceId, listingSourceId);
    assert.equal("shopId" in publicRecord, false);
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
      listingSourceId,
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

  it("rejects records without a valid source or connection identity", async () => {
    const record = {
      listingSourceId,
      accessToken: "synthetic-access-token",
      connectionId: "fixture-connection",
      updatedAt: "2026-10-30T00:00:00.000Z",
    };
    for (const invalid of [
      { ...record, listingSourceId: `ls_8${"0".repeat(25)}` },
      { ...record, connectionId: undefined },
      { ...record, connectionId: "" },
      { ...record, connectionId: 123 },
    ]) {
      assert.equal(
        await loadShopCredentials(
          { get: async () => JSON.stringify(invalid) } as never,
          "example-shop.myshopify.com",
        ),
        null,
      );
    }
  });

  it("clears app-owned Aura Historia connection data on uninstall", () => {
    assert.ok(uninstallWebhookRoute.includes("loadShopCredentials"));
    assert.ok(uninstallWebhookRoute.includes("disconnectShipping(shop, true)"));
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
