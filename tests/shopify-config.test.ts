import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const appConfig = readFileSync(
  resolve(process.cwd(), "shopify.app.toml"),
  "utf8",
);

describe("shopify.app.toml", () => {
  it("uses the review-facing Aura Historia app name", () => {
    assert.match(appConfig, /name = "Aura Historia Partner Connect"/);
  });

  it("routes product lifecycle topics to EventBridge", () => {
    assert.match(
      appConfig,
      /topics = \["products\/create", "products\/update", "products\/delete"\]\s+uri = "arn:aws:events:eu-central-1::event-source\/aws\.partner\/shopify\.com\/359227195393\/aura-historia-backend-dev"/,
    );
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
      /topics = \["app\/uninstalled"\]\s+uri = "https:\/\/shopify\.aura-historia\.com\/webhooks\/app\/uninstalled"/,
    );
  });

  it("allows the Shopify auth callback URLs used by the app", () => {
    assert.ok(
      appConfig.includes("https://partner-connect.aura-historia.com/auth/callback"),
    );
  });
});
