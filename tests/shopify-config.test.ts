import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const appConfig = readFileSync(
  resolve(process.cwd(), "shopify.app.toml"),
  "utf8",
);
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/shopify-shipping-webhooks-2026-10.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const marketFixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/shopify-market-shipping-2026-10.json", import.meta.url),
    "utf8",
  ),
);

describe("shopify.app.toml", () => {
  it("delivers all profile and market hints and scope changes to the app in every environment", () => {
    for (const name of [
      "shopify.app.toml",
      "shopify.app.prod.toml",
      "shopify.app.tunnel.toml",
    ]) {
      const config = readFileSync(resolve(process.cwd(), name), "utf8");
      assert.match(config, new RegExp(`api_version = "${fixture.apiVersion}"`));
      const blocks = config.split("[[webhooks.subscriptions]]");
      for (const topic of [
        ...fixture.topics,
        ...marketFixture.evidence.webhookTopics,
        "app/scopes_update",
      ]) {
        const subscriptions = blocks.filter((block) =>
          block.includes(`"${topic}"`),
        );
        assert.equal(subscriptions.length, 1);
        const destination = name.includes("tunnel")
          ? "/webhooks/shipping"
          : "https://partner-connect.aura-historia.com/webhooks/shipping";
        assert.ok(subscriptions[0].includes(`uri = "${destination}"`));
      }
      for (const topic of [
        "product_listings/add",
        "product_listings/update",
        "product_listings/remove",
        "customers/data_request",
        "customers/redact",
        "shop/redact",
      ]) {
        const subscription = blocks.find((block) =>
          block.includes(`"${topic}"`),
        );
        assert.ok(subscription);
        assert.ok(subscription.includes('uri = "arn:aws:events:'));
        assert.ok(
          subscription.includes(
            name.includes("prod") ? "backend-prod" : "backend-dev",
          ),
        );
      }
    }
  });
  it("requires the shipping scope of the static profile subscriptions in every environment", () => {
    const wrangler = readFileSync(
      resolve(process.cwd(), "wrangler.jsonc"),
      "utf8",
    );
    for (const path of [
      "shopify.app.toml",
      "shopify.app.prod.toml",
      "shopify.app.tunnel.toml",
    ]) {
      const config = readFileSync(resolve(process.cwd(), path), "utf8");
      const scopes = config.match(/^scopes = "([^"]*)"$/m)?.[1];
      assert.equal(
        scopes,
        "read_products,read_product_listings,read_locales,read_shipping,read_markets",
      );
      // Shopify rejects static subscriptions whose scope is only optional.
      assert.ok(scopes.split(",").includes(fixture.requiredScope));
      assert.ok(
        scopes.split(",").includes(marketFixture.evidence.requiredScope),
      );
      assert.ok(scopes.split(",").includes("read_product_listings"));
      assert.doesNotMatch(config, /^optional_scopes\b/m);
      assert.ok(wrangler.includes(`"SCOPES": "${scopes}"`));
    }
  });

  it("uses the review-facing Aura Historia app name", () => {
    assert.match(appConfig, /^name = "Aura Historia"$/m);
  });

  it("pins the admin URL handle used by app links in every environment", () => {
    const linkSources = [
      "app/shopify-admin-url.ts",
      "app/routes/auth.$.tsx",
    ].map((path) => readFileSync(resolve(process.cwd(), path), "utf8"));
    for (const name of [
      "shopify.app.toml",
      "shopify.app.prod.toml",
      "shopify.app.tunnel.toml",
    ]) {
      const config = readFileSync(resolve(process.cwd(), name), "utf8");
      const handle = config.match(/^handle = "([^"]*)"$/m)?.[1];
      assert.equal(handle, "aura-historia-partner-connect", name);
      for (const source of linkSources) {
        assert.ok(source.includes(`/apps/${handle}`));
      }
    }
  });

  it("routes own-channel product listing topics to EventBridge", () => {
    assert.match(
      appConfig,
      /topics = \["product_listings\/add", "product_listings\/update", "product_listings\/remove"\]\s+uri = "arn:aws:events:eu-central-1::event-source\/aws\.partner\/shopify\.com\/359227195393\/aura-historia-backend-dev"/,
    );
  });

  it("replaces the shop-wide product topics in every environment", () => {
    for (const name of [
      "shopify.app.toml",
      "shopify.app.prod.toml",
      "shopify.app.tunnel.toml",
    ]) {
      const config = readFileSync(resolve(process.cwd(), name), "utf8");
      assert.doesNotMatch(config, /"products\/(create|update|delete)"/, name);
    }
  });

  it("includes mandatory public app compliance topics", () => {
    assert.match(
      appConfig,
      /compliance_topics = \["customers\/data_request", "customers\/redact", "shop\/redact"\]\s+uri = "arn:aws:events:eu-central-1::event-source\/aws\.partner\/shopify\.com\/359227195393\/aura-historia-backend-dev"/,
    );
  });

  it("keeps uninstall cleanup on the deployed app URL for localhost dev compatibility", () => {
    assert.match(
      appConfig,
      /topics = \["app\/uninstalled"\]\s+uri = "https:\/\/partner-connect\.aura-historia\.com\/webhooks\/app\/uninstalled"/,
    );
  });

  it("allows the Shopify auth callback URLs used by the app", () => {
    assert.ok(
      appConfig.includes(
        "https://partner-connect.aura-historia.com/auth/callback",
      ),
    );
  });
});
