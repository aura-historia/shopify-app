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
    assert.match(appConfig, /api_version = "2026-10"/);
    assert.match(shopifyServer, /const apiVersion = ApiVersion\.October26;/);
  });

  it("keeps runtime scopes aligned with every Shopify app configuration", () => {
    const wrangler = readFileSync(
      resolve(process.cwd(), "wrangler.jsonc"),
      "utf8",
    );
    const runtimeScopes = wrangler.match(/"SCOPES": "([^"]*)"/)?.[1];
    for (const name of [
      "shopify.app.toml",
      "shopify.app.prod.toml",
      "shopify.app.tunnel.toml",
    ]) {
      const config = readFileSync(resolve(process.cwd(), name), "utf8");
      assert.equal(config.match(/^scopes = "([^"]*)"$/m)?.[1], runtimeScopes);
      assert.match(config, /api_version = "2026-10"/);
    }
    assert.match(wrangler, /"SHOPIFY_API_VERSION": "2026-10"/);
  });

  it("keeps the auth path prefix on /auth", () => {
    assert.match(shopifyServer, /authPathPrefix: "\/auth"/);
  });

  it("does not use removed custom-shop domain configuration", () => {
    assert.equal(shopifyServer.includes("SHOP_CUSTOM_DOMAIN"), false);
    assert.equal(shopifyServer.includes("customShopDomains"), false);
  });
});
