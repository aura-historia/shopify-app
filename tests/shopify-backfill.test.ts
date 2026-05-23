import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const shopifyServer = readFileSync(
  resolve(process.cwd(), "app/shopify.server.ts"),
  "utf8",
);

describe("installation product backfill", () => {
  it("starts the backfill from the Shopify afterAuth hook", () => {
    assert.match(shopifyServer, /afterAuth: async \(\{ admin, session \}\) =>/);
    assert.match(
      shopifyServer,
      /await startInstallationProductBackfill\(admin, session\.shop\);/,
    );
  });

  it("registers a bulk operation finish webhook against the placeholder target", () => {
    assert.match(
      shopifyServer,
      /webhookSubscriptions\(first: 50, topics: \[BULK_OPERATIONS_FINISH\]\)/,
    );
    assert.match(
      shopifyServer,
      /webhookSubscriptionCreate\(\s+topic: BULK_OPERATIONS_FINISH/,
    );
    assert.ok(
      shopifyServer.includes(
        "https://example.com/shopify/bulk-operations/finish",
      ),
    );
  });

  it("uses Shopify bulk queries to backfill products", () => {
    assert.match(shopifyServer, /bulkOperationRunQuery\(query: \$query\)/);
    assert.match(shopifyServer, /products \{/);
    assert.match(shopifyServer, /createdAt/);
    assert.match(shopifyServer, /updatedAt/);
  });
});
