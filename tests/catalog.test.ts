import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type GraphqlRequestFn,
  transformProduct,
} from "../app/backfill.server";
import {
  getChannelPublication,
  readCatalogImportStatus,
  resolveChannelPublication,
} from "../app/catalog.server";
import { exactMoney } from "../app/shipping/mapper";
import {
  boundChannel,
  channelGraphql,
  channelListingSourceId,
} from "./helpers/channel-fixtures";

const granted = ["read_products", "read_product_listings", "read_publications"];
const listingSourceId = channelListingSourceId;

describe("release catalog behavior", () => {
  const shop = "example.myshopify.com";
  it("reports the channel's published count and an editor scoped to its publication", async () => {
    const publication = await getChannelPublication(
      channelGraphql({
        channel: boundChannel({
          productsCount: { count: 10000, precision: "AT_LEAST" },
        }),
        publication: { id: "gid://shopify/Publication/123" },
      }),
      shop,
      listingSourceId,
    );
    assert.equal(publication.state, "ready");
    if (publication.state !== "ready") return;
    assert.equal(publication.count, 10000);
    assert.equal(publication.atLeast, true);
    const url = new URL(publication.editorUrl);
    assert.equal(url.origin, "https://admin.shopify.com");
    assert.equal(url.searchParams.get("edit"), "publications.123.published_at");
  });
  it("keeps the editor link when only the published count is unavailable", async () => {
    const publication = await getChannelPublication(
      channelGraphql({
        channel: boundChannel({
          productsCount: { count: -1, precision: "EXACT" },
        }),
        publication: { id: "gid://shopify/Publication/123" },
      }),
      shop,
      listingSourceId,
    );
    assert.equal(publication.state, "ready");
    if (publication.state !== "ready") return;
    assert.equal(publication.count, null);
    assert.equal(publication.atLeast, false);
    assert.match(publication.editorUrl, /publications\.123\.published_at/);
  });
  it("counts only active products published to the channel", async () => {
    const queries: string[] = [];
    await getChannelPublication(
      async (query, variables) => {
        queries.push(query);
        return channelGraphql()(query, variables);
      },
      shop,
      listingSourceId,
    );
    assert.match(
      queries.find((query) => query.includes("AuraChannelConnection")) ?? "",
      /productsCount\(query: "status:active"\)/,
    );
  });
  it("never turns unavailable or malformed channel data into a zero count", async () => {
    for (const graphql of [
      async () => ({ data: undefined }),
      async () => ({ data: {} }),
      channelGraphql({ channel: new Error("private provider diagnostics") }),
      channelGraphql({ channel: { id: "untrusted" } }),
      channelGraphql({ publication: { id: "gid://shopify/Channel/1" } }),
      channelGraphql({
        publication: new Error("private provider diagnostics"),
      }),
    ] as GraphqlRequestFn[]) {
      assert.deepEqual(
        await getChannelPublication(graphql, shop, listingSourceId),
        { state: "unavailable" },
      );
    }
    assert.deepEqual(
      await getChannelPublication(
        async () => {
          throw new Error("private provider diagnostics");
        },
        shop,
        listingSourceId,
      ),
      { state: "unavailable" },
    );
  });
  it("distinguishes missing access, connection, publication and failed reads", async () => {
    // A missing grant is reported even when the channel reads would fail.
    // Installations approved before `read_publications` was required keep
    // listing access but cannot read the publication.
    for (const scopes of [
      ["read_products"],
      ["read_products", "read_publications"],
      ["read_products", "read_product_listings", "read_shipping"],
    ])
      for (const channel of [boundChannel(), new Error("Access denied")]) {
        assert.deepEqual(
          await resolveChannelPublication(
            channelGraphql({ scopes, channel }),
            listingSourceId,
          ),
          { state: "missing_scope" },
        );
      }
    // No connection, or one bound to another listing source or specification,
    // selects nothing for this source.
    for (const channel of [
      null,
      boundChannel({ accountId: `ls_${"1".repeat(26)}` }),
      boundChannel({ specificationHandle: null }),
    ]) {
      assert.deepEqual(
        await resolveChannelPublication(
          channelGraphql({ channel }),
          listingSourceId,
        ),
        { state: "missing_channel" },
      );
    }
    assert.deepEqual(
      await resolveChannelPublication(
        channelGraphql({ publication: null }),
        listingSourceId,
      ),
      { state: "missing_publication" },
    );
    assert.deepEqual(
      await resolveChannelPublication(
        channelGraphql({ channel: new Error("Internal error") }),
        listingSourceId,
      ),
      { state: "unavailable" },
    );
    for (const scopes of [
      granted,
      ["write_product_listings", "write_publications"],
    ]) {
      assert.deepEqual(
        await resolveChannelPublication(
          channelGraphql({
            scopes,
            publication: { id: "gid://shopify/Publication/1" },
          }),
          listingSourceId,
        ),
        { state: "ready", publicationId: "gid://shopify/Publication/1" },
      );
    }
  });
  it("never reads the deprecated installation publication", async () => {
    const queries: string[] = [];
    await resolveChannelPublication(async (query, variables) => {
      queries.push(query);
      return channelGraphql()(query, variables);
    }, listingSourceId);
    // Access, connection, catalog scan and the own catalog's publication.
    assert.equal(queries.length, 4);
    for (const query of queries)
      assert.doesNotMatch(query, /currentAppInstallation\s*\{\s*publication/);
  });
  it("only exposes public catalog progress fields from stored state", () => {
    const status = readCatalogImportStatus({
      phase: "failed",
      total: 3,
      failed: 1,
      updatedAt: "2026-10-26T00:00:00Z",
      accessToken: "must not escape",
    });
    assert.equal(status?.failed, 1);
    assert.doesNotMatch(JSON.stringify(status), /accessToken|must not escape/);
    for (const absent of [undefined, null, "submitted"])
      assert.equal(readCatalogImportStatus(absent), null);
  });
  it("keeps inconsistent progress from breaking the app", () => {
    for (const inconsistent of [
      { failed: 2 },
      { eligible: 2 },
      { error: "PRIVATE_DIAGNOSTICS" },
      { withdrawn: -1 },
      { phase: "running" },
      { updatedAt: "yesterday" },
    ]) {
      assert.equal(
        readCatalogImportStatus({
          phase: "failed",
          total: 1,
          failed: 0,
          updatedAt: new Date().toISOString(),
          ...inconsistent,
        }),
        null,
      );
    }
  });
  it("keeps channel-filtered import outcomes", () => {
    const status = readCatalogImportStatus({
      phase: "failed",
      total: 4,
      failed: 2,
      eligible: 1,
      withdrawn: 3,
      error: "INCOMPLETE_EXPORT",
      updatedAt: new Date().toISOString(),
    });
    assert.equal(status?.eligible, 1);
    assert.equal(status?.withdrawn, 3);
    assert.equal(status?.error, "INCOMPLETE_EXPORT");
  });
  it("reports interrupted background imports as failures after their processing window", () => {
    for (const [phase, minutes, expected] of [
      ["processing", 6, "failed"],
      ["processing", 4, "processing"],
      ["queued", 61, "failed"],
      ["queued", 59, "queued"],
    ] as const)
      assert.equal(
        readCatalogImportStatus({
          phase,
          total: 0,
          failed: 0,
          updatedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
        })?.phase,
        expected,
      );
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
