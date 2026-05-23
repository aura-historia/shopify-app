import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  getShopCredentialsStorageKey,
  isValidAuraHistoriaApiKey,
  isValidShopId,
  loadShopCredentials,
  saveShopCredentials,
  validateShopCredentialsFormData,
} from "../app/shop-credentials.server";

const appRoute = readFileSync(
  resolve(process.cwd(), "app/routes/app.tsx"),
  "utf8",
);

describe("shop credentials configuration", () => {
  it("requires both fields", () => {
    const validation = validateShopCredentialsFormData(new FormData());

    assert.equal(validation.isValid, false);
    assert.deepEqual(validation.errors, {
      apiKey: "Please enter your Aura Historia API key",
      shopId: "Please enter your Aura Historia shop ID",
    });
  });

  it("validates the expected shop ID and API key formats", () => {
    const validShopId = randomUUID();
    const validApiKey = "aurahistoria_partner_1234567890abcdef";

    assert.equal(isValidShopId(validShopId), true);
    assert.equal(isValidShopId("not-a-uuid"), false);
    assert.equal(isValidAuraHistoriaApiKey(validApiKey), true);
    assert.equal(isValidAuraHistoriaApiKey("aurahistoria_missingtail"), false);
  });

  it("trims and accepts valid credentials", () => {
    const formData = new FormData();
    formData.set("shopId", ` ${randomUUID()} `);
    formData.set("apiKey", " aurahistoria_partner_abcdef123456 ");

    const validation = validateShopCredentialsFormData(formData);

    assert.equal(validation.isValid, true);
    assert.deepEqual(validation.errors, {});
    assert.match(validation.values.shopId, /^[0-9a-f-]{36}$/i);
    assert.equal(validation.values.apiKey, "aurahistoria_partner_abcdef123456");
  });

  it("stores credentials per shop with a dedicated KV prefix", () => {
    assert.equal(
      getShopCredentialsStorageKey("example-shop.myshopify.com"),
      "aura-historia:shop-credentials:example-shop.myshopify.com",
    );
  });

  it("round-trips credentials through Cloudflare KV", async () => {
    const entries = new Map<string, string>();
    const kv = {
      get: async (key: string) => entries.get(key) ?? null,
      put: async (key: string, value: string) => {
        entries.set(key, value);
      },
    };

    await saveShopCredentials(kv as never, "example-shop.myshopify.com", {
      shopId: randomUUID(),
      apiKey: "aurahistoria_partner_abcdef123456",
    });

    const savedRecord = await loadShopCredentials(
      kv as never,
      "example-shop.myshopify.com",
    );

    assert.ok(savedRecord);
    assert.match(savedRecord.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(savedRecord.apiKey, "aurahistoria_partner_abcdef123456");
  });

  it("marks the embedded app response as non-cacheable", () => {
    assert.match(
      appRoute,
      /headers\.set\("Cache-Control", "private, no-store"\)/,
    );
  });
});
