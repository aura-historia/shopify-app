import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, mock } from "node:test";
import type { CatalogImportJob } from "../app/backfill.server";
import { action } from "../app/routes/webhooks.bulk-operations.finish";
import {
  createImporter,
  ImporterStorage,
  importsOf,
  memoryKv,
} from "./helpers/catalog-importer";

const shop = "example.myshopify.com";
const bulkOperationId = "gid://shopify/BulkOperation/123";

// The shop's actual importer with a queued export for `bulkOperationId`.
async function queuedImporter() {
  const kv = memoryKv();
  const storage = new ImporterStorage();
  const importer = createImporter(storage, { KV: kv } as never);
  const imports = importsOf(() => importer, shop);
  const generation = (await imports.begin()) as number;
  await imports.queue(generation, {
    listingSourceId: `ls_${"0".repeat(26)}`,
    accessToken: "synthetic-aura-token",
    apiBaseUrl: "https://aura.invalid",
    currencyCode: "EUR",
    shopDomain: shop,
    bulkOperationId,
    publicationId: "gid://shopify/Publication/456",
    createdAt: new Date().toISOString(),
  });
  return {
    importer,
    imports,
    storage,
    contextKey: `aura-historia:backfill:${shop}:${generation}`,
    kv,
    job: () => storage.get<CatalogImportJob>("job"),
  };
}

async function deliver(
  importer: {
    start: (bulkOperationId: string) => Promise<void>;
    exportFailed: (bulkOperationId: string) => Promise<void>;
  },
  {
    status = "completed",
    operation = bulkOperationId,
    topic = "bulk_operations/finish",
    payload = undefined as unknown,
  } = {},
) {
  const body = JSON.stringify(
    payload === undefined
      ? {
          type: "query",
          status,
          admin_graphql_api_id: operation,
        }
      : payload,
  );
  const getByName = mock.fn(() => importer);
  const response = await action({
    request: new Request(
      "https://app.invalid/webhooks/bulk-operations/finish",
      {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": topic,
          "X-Shopify-Shop-Domain": shop,
          "X-Shopify-API-Version": "2026-10",
          "X-Shopify-Webhook-Id": crypto.randomUUID(),
          "X-Shopify-Hmac-Sha256": createHmac("sha256", "synthetic-secret")
            .update(body)
            .digest("base64"),
        },
      },
    ),
    context: {
      cloudflare: {
        env: {
          KV: memoryKv(),
          SHOPIFY_API_KEY: "synthetic-key",
          SHOPIFY_API_SECRET: "synthetic-secret",
          SHOPIFY_APP_URL: "https://app.invalid",
          CATALOG_IMPORTER: { getByName },
        },
        ctx: {
          waitUntil: () => {
            throw new Error("Processing must not run in waitUntil");
          },
        },
      },
    },
    params: {},
  } as never);
  return { response, getByName };
}

describe("catalog completion webhook", () => {
  it("rejects another signed topic and malformed bodies without admitting work", async () => {
    for (const options of [
      { topic: "app/uninstalled" },
      { payload: null },
      { payload: [] },
    ]) {
      const importer = {
        start: mock.fn(async () => {}),
        exportFailed: mock.fn(async () => {}),
      };
      const { response } = await deliver(importer, options);
      assert.equal(response.status, 400);
      assert.equal(importer.start.mock.callCount(), 0);
      assert.equal(importer.exportFailed.mock.callCount(), 0);
    }
  });

  it("durably admits the matching export to the shop's catalog importer", async () => {
    const catalog = await queuedImporter();
    const { response, getByName } = await deliver(catalog.importer);
    assert.equal(response.status, 200);
    assert.deepEqual(getByName.mock.calls[0].arguments, [shop]);
    assert.equal((await catalog.job())?.admitted, true);
    assert.ok(catalog.storage.alarm);
    // The importer owns the context until the import finishes.
    assert.ok(catalog.kv.entries.has(catalog.contextKey));
  });

  it("asks Shopify to retry when admission cannot be committed", async () => {
    for (const status of ["completed", "failed"]) {
      const { response } = await deliver(
        {
          start: async () => {
            throw new Error("Durable Object unavailable");
          },
          exportFailed: async () => {
            throw new Error("Durable Object unavailable");
          },
        },
        { status },
      );
      assert.equal(response.status, 503);
    }
  });

  it("ignores exports that are not the shop's current import", async () => {
    for (const status of ["completed", "failed"]) {
      const catalog = await queuedImporter();
      const { response } = await deliver(catalog.importer, {
        status,
        operation: "gid://shopify/BulkOperation/999",
      });
      assert.equal(response.status, 200);
      assert.equal((await catalog.job())?.admitted, false);
      assert.equal(catalog.storage.alarm, null);
      assert.equal((await catalog.imports.status())?.phase, "queued");
    }
  });

  it("records a failed Shopify export as a retryable read failure", async () => {
    const catalog = await queuedImporter();
    await deliver(catalog.importer, { status: "failed" });
    assert.equal(catalog.storage.alarm, null);
    assert.equal(await catalog.job(), undefined);
    const status = await catalog.imports.status();
    assert.equal(status?.phase, "failed");
    assert.equal(status?.error, "SHOPIFY_READ_FAILED");
    assert.equal(catalog.kv.entries.has(catalog.contextKey), false);
  });
});
