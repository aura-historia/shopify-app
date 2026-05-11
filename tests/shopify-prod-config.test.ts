import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const prodConfig = readFileSync(
  resolve(process.cwd(), "shopify.app.prod.toml"),
  "utf8",
);

describe("shopify.app.prod.toml", () => {
  it("routes product lifecycle topics to the production EventBridge partner source", () => {
    assert.match(
      prodConfig,
      /topics = \["products\/create", "products\/update", "products\/delete"\]\s+uri = "arn:aws:events:eu-central-1::event-source\/aws\.partner\/shopify\.com\/359227195393\/aura-historia-backend-prod"/,
    );
  });

  it("includes mandatory public app compliance topics on the production partner source", () => {
    assert.match(
      prodConfig,
      /compliance_topics = \["customers\/data_request", "customers\/redact", "shop\/redact"\]\s+uri = "arn:aws:events:eu-central-1::event-source\/aws\.partner\/shopify\.com\/359227195393\/aura-historia-backend-prod"/,
    );
  });

  it("keeps uninstall cleanup on the deployed app URL", () => {
    assert.match(
      prodConfig,
      /topics = \["app\/uninstalled"\]\s+uri = "https:\/\/shopify\.aura-historia\.com\/webhooks\/app\/uninstalled"/,
    );
  });
});
