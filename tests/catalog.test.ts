import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transformProduct } from "../app/backfill.server";
import {
  clearCatalogImportStatus,
  getChannelPublication,
  loadCatalogImportStatus,
  resolveChannelPublication,
  saveCatalogImportStatus,
} from "../app/catalog.server";
import { exactMoney } from "../app/shipping/mapper";

const granted = [
  { handle: "read_products" },
  { handle: "read_product_listings" },
];

describe("release catalog behavior", () => {
  const shop = "example.myshopify.com";
  it("reports channel-specific publication counts and an editor scoped to that publication", async () => {
    const publication = await getChannelPublication(async (query) => {
      assert.match(query, /accessScopes/);
      assert.match(query, /includedProductsCount/);
      return {
        data: {
          currentAppInstallation: {
            accessScopes: granted,
            publication: {
              id: "gid://shopify/Publication/123",
              includedProductsCount: { count: 10000, precision: "AT_LEAST" },
            },
          },
        },
      };
    }, shop);
    assert.equal(publication.state, "ready");
    if (publication.state !== "ready") return;
    assert.equal(publication.count, 10000);
    assert.equal(publication.atLeast, true);
    const url = new URL(publication.editorUrl);
    assert.equal(url.origin, "https://admin.shopify.com");
    assert.equal(url.searchParams.get("edit"), "publications.123.published_at");
  });
  it("keeps the editor link when only the selected count is unavailable", async () => {
    const publication = await getChannelPublication(
      async () => ({
        data: {
          currentAppInstallation: {
            accessScopes: granted,
            publication: {
              id: "gid://shopify/Publication/123",
              includedProductsCount: { count: -1, precision: "EXACT" },
            },
          },
        },
      }),
      shop,
    );
    assert.equal(publication.state, "ready");
    if (publication.state !== "ready") return;
    assert.equal(publication.count, null);
    assert.equal(publication.atLeast, false);
    assert.match(publication.editorUrl, /publications\.123\.published_at/);
  });
  it("never turns unavailable or malformed publication data into a zero count", async () => {
    for (const data of [
      undefined,
      {},
      { currentAppInstallation: { publication: null } },
      {
        currentAppInstallation: {
          accessScopes: granted,
          publication: { id: "untrusted", includedProductsCount: { count: 0 } },
        },
      },
    ]) {
      assert.deepEqual(
        await getChannelPublication(async () => ({ data }), shop),
        { state: "unavailable" },
      );
    }
    assert.deepEqual(
      await getChannelPublication(async () => {
        throw new Error("private provider diagnostics");
      }, shop),
      { state: "unavailable" },
    );
  });
  it("distinguishes missing access, a missing publication and failed reads", async () => {
    const response = (installation: unknown, errors?: unknown) => async () => ({
      data: { currentAppInstallation: installation },
      errors,
    });
    assert.deepEqual(
      await resolveChannelPublication(
        response({
          accessScopes: [{ handle: "read_products" }],
          publication: { id: "gid://shopify/Publication/1" },
        }),
      ),
      { state: "missing_scope" },
    );
    // A missing grant is reported even when Shopify also denies the field.
    assert.deepEqual(
      await resolveChannelPublication(
        response({ accessScopes: [{ handle: "read_products" }] }, [
          { message: "Access denied" },
        ]),
      ),
      { state: "missing_scope" },
    );
    assert.deepEqual(
      await resolveChannelPublication(
        response({ accessScopes: granted, publication: null }),
      ),
      { state: "missing_publication" },
    );
    assert.deepEqual(
      await resolveChannelPublication(
        response(
          {
            accessScopes: granted,
            publication: { id: "gid://shopify/Publication/1" },
          },
          [{ message: "Internal error" }],
        ),
      ),
      { state: "unavailable" },
    );
    assert.deepEqual(
      await resolveChannelPublication(
        response({
          accessScopes: granted,
          publication: { id: "gid://shopify/Publication/1" },
        }),
      ),
      { state: "ready", publicationId: "gid://shopify/Publication/1" },
    );
  });
  it("only exposes public catalog progress fields from stored state", async () => {
    const status = await loadCatalogImportStatus(
      {
        get: async () =>
          JSON.stringify({
            phase: "failed",
            total: 3,
            failed: 1,
            updatedAt: "2026-10-26T00:00:00Z",
            accessToken: "must not escape",
          }),
      } as never,
      shop,
    );
    assert.equal(status?.failed, 1);
    assert.doesNotMatch(JSON.stringify(status), /accessToken|must not escape/);
    assert.equal(
      await loadCatalogImportStatus({ get: async () => "null" } as never, shop),
      null,
    );
  });
  it("keeps unavailable or inconsistent progress from breaking the app", async () => {
    assert.equal(
      await loadCatalogImportStatus(
        {
          get: async () => {
            throw new Error("KV unavailable");
          },
        } as never,
        shop,
      ),
      null,
    );
    assert.equal(
      await loadCatalogImportStatus(
        {
          get: async () =>
            JSON.stringify({
              phase: "submitted",
              total: 1,
              failed: 0,
              eligible: 2,
              updatedAt: new Date().toISOString(),
            }),
        } as never,
        shop,
      ),
      null,
    );
    for (const extra of [
      { error: "PRIVATE_DIAGNOSTICS" },
      { reconciled: "yes" },
      { withdrawn: -1 },
    ]) {
      assert.equal(
        await loadCatalogImportStatus(
          {
            get: async () =>
              JSON.stringify({
                phase: "failed",
                total: 1,
                failed: 0,
                updatedAt: new Date().toISOString(),
                ...extra,
              }),
          } as never,
          shop,
        ),
        null,
      );
    }
  });
  it("keeps reconciliation outcomes, including absent-record failures", async () => {
    const status = await loadCatalogImportStatus(
      {
        get: async () =>
          JSON.stringify({
            phase: "failed",
            total: 0,
            failed: 2,
            eligible: 0,
            withdrawn: 3,
            reconciled: false,
            error: "RECONCILIATION_FAILED",
            updatedAt: new Date().toISOString(),
          }),
      } as never,
      shop,
    );
    assert.equal(status?.failed, 2);
    assert.equal(status?.withdrawn, 3);
    assert.equal(status?.reconciled, false);
    assert.equal(status?.error, "RECONCILIATION_FAILED");
  });
  it("retries rapid status writes after KV's per-key write window", async () => {
    const writes: { value: string; time: number }[] = [];
    await saveCatalogImportStatus(
      {
        put: async (_key: string, value: string) => {
          writes.push({ value, time: Date.now() });
          if (writes.length === 1)
            throw new Error("KV put failed: 429 Too Many Requests");
        },
      } as never,
      shop,
      { phase: "submitted", total: 1, failed: 0 },
    );
    assert.equal(writes.length, 2);
    assert.ok(writes[1].time - writes[0].time >= 950);
    assert.equal(writes[1].value, writes[0].value);
    assert.equal(JSON.parse(writes[1].value).phase, "submitted");
  });
  it("keeps failed progress cleanup from preventing disconnection or uninstall", async () => {
    let attempts = 0;
    await clearCatalogImportStatus(
      {
        delete: async () => {
          attempts++;
          throw new Error("KV unavailable");
        },
      } as never,
      shop,
    );
    assert.equal(attempts, 3);
  });
  it("reports interrupted background imports as failures after their processing window", async () => {
    const status = await loadCatalogImportStatus(
      {
        get: async () =>
          JSON.stringify({
            phase: "processing",
            total: 0,
            failed: 0,
            updatedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
          }),
      } as never,
      shop,
    );
    assert.equal(status?.phase, "failed");
  });
  it("maps new backend currencies and zero-decimal KRW consistently for catalog and shipping", () => {
    for (const [currency, price, amount] of [
      ["ARS", "12.34", 1234],
      ["SEK", "0.50", 50],
      ["KRW", "1234", 1234],
    ] as const) {
      assert.deepEqual(exactMoney({ currencyCode: currency, amount: price }), {
        currency,
        amount_minor: amount,
      });
      const product = {
        id: "123",
        title: "Clock",
        handle: "clock",
        status: "ACTIVE",
        totalInventory: 1,
        tracksInventory: true,
        onlineStoreUrl: null,
        publishedOnPublication: true,
      };
      assert.deepEqual(
        transformProduct(product, [], price, "en", currency, shop).price,
        { type: "MONETARY", currency, amount },
      );
    }
  });
});
