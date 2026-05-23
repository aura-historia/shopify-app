import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const shopifyServer = readFileSync(
  resolve(process.cwd(), "app/shopify.server.ts"),
  "utf8",
);
const wranglerConfig = readFileSync(
  resolve(process.cwd(), "wrangler.jsonc"),
  "utf8",
);

describe("installation product backfill", () => {
  it("starts the backfill from the Shopify afterAuth hook", () => {
    assert.match(shopifyServer, /afterAuth: async \(\{ admin, session \}\) =>/);
    assert.match(
      shopifyServer,
      /await startInstallationProductBackfill\(\s+admin,\s+config\.auraHistoriaApiBaseUrl,\s+session\.shop,\s+\);/,
    );
  });

  it("builds the bulk operation finish webhook target from the configured Aura Historia API base URL", () => {
    assert.match(
      shopifyServer,
      /webhookSubscriptions\(first: 50, topics: \[BULK_OPERATIONS_FINISH\]\)/,
    );
    assert.match(
      shopifyServer,
      /webhookSubscriptionCreate\(\s+topic: BULK_OPERATIONS_FINISH/,
    );
    assert.match(
      shopifyServer,
      /new URL\(AURA_HISTORIA_SYNC_WEBHOOK_PATH, baseUrl\)\.toString\(\)/,
    );
    assert.match(
      shopifyServer,
      /AURA_HISTORIA_SYNC_WEBHOOK_PATH =\s+"\/api\/v1\/webhooks\/shopify\/sync"/,
    );
  });

  it("uses the dev API base URL by default and the prod override in wrangler config", () => {
    assert.match(
      wranglerConfig,
      /"AURA_HISTORIA_API_BASE_URL": "https:\/\/api\.dev\.aura-historia\.com"/,
    );
    assert.match(
      wranglerConfig,
      /"production": \{\s+"vars": \{\s+"AURA_HISTORIA_API_BASE_URL": "https:\/\/api\.aura-historia\.com"/,
    );
  });

  it("uses Shopify bulk queries to backfill products", () => {
    assert.match(shopifyServer, /bulkOperationRunQuery\(query: \$query\)/);
    assert.match(shopifyServer, /products \{/);
    assert.match(shopifyServer, /descriptionHtml/);
    assert.match(shopifyServer, /images \{/);
    assert.match(shopifyServer, /variants \{/);
    assert.match(shopifyServer, /availableForSale/);
    assert.match(shopifyServer, /price/);
    assert.match(shopifyServer, /createdAt/);
    assert.match(shopifyServer, /updatedAt/);
  });
});
