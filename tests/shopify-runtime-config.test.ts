import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const shopifyServer = readFileSync(
  resolve(process.cwd(), "app/shopify.server.ts"),
  "utf8",
);
const appConfig = readFileSync(
  resolve(process.cwd(), "shopify.app.toml"),
  "utf8",
);

describe("shopify runtime configuration", () => {
  it("keeps the Shopify API version aligned between runtime and app config", () => {
    assert.match(appConfig, /api_version = "2026-04"/);
    assert.match(shopifyServer, /const apiVersion = ApiVersion\.April26;/);
  });

  it("keeps the auth path prefix on /auth", () => {
    assert.match(shopifyServer, /authPathPrefix: "\/auth"/);
  });

  it("does not use removed custom-shop domain configuration", () => {
    assert.equal(shopifyServer.includes("SHOP_CUSTOM_DOMAIN"), false);
    assert.equal(shopifyServer.includes("customShopDomains"), false);
  });
});
