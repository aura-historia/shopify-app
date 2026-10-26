import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { transformProduct } from "../app/backfill.server";
import {
  getChannelPublication,
  loadCatalogImportStatus,
} from "../app/catalog.server";
import { exactMoney } from "../app/shipping/mapper";

describe("release catalog behavior", () => {
  const shop = "example.myshopify.com";
  it("reports channel-specific publication counts and an editor scoped to that publication", async () => {
    const publication = await getChannelPublication(
      async () => ({
        data: {
          currentAppInstallation: {
            publication: {
              id: "gid://shopify/Publication/123",
              includedProductsCount: { count: 10000, precision: "AT_LEAST" },
            },
          },
        },
      }),
      shop,
    );
    assert.equal(publication?.count, 10000);
    assert.equal(publication?.atLeast, true);
    const url = new URL(publication?.editorUrl ?? "");
    assert.equal(url.origin, "https://admin.shopify.com");
    assert.equal(url.searchParams.get("edit"), "publications.123.published_at");
  });
  it("never turns unavailable or malformed publication data into a zero count", async () => {
    for (const data of [
      undefined,
      {},
      { currentAppInstallation: { publication: null } },
      {
        currentAppInstallation: {
          publication: { id: "untrusted", includedProductsCount: { count: 0 } },
        },
      },
    ]) {
      assert.equal(
        await getChannelPublication(async () => ({ data }), shop),
        null,
      );
    }
    assert.equal(
      await getChannelPublication(async () => {
        throw new Error("private provider diagnostics");
      }, shop),
      null,
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
      };
      assert.deepEqual(
        transformProduct(product, [], price, "en", currency, shop).price,
        { type: "MONETARY", currency, amount },
      );
    }
  });
});
