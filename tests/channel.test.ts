import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type { GraphqlRequestFn } from "../app/backfill.server";
import {
  AURA_CHANNEL_HANDLE,
  AURA_CHANNEL_SPECIFICATION_HANDLE,
  ensureAuraChannel,
  findChannelPublication,
  readCatalogAccess,
  readListingAccess,
} from "../app/channel.server";

const listingSourceId = `ls_${"0".repeat(26)}`;
const otherSourceId = `ls_${"1".repeat(26)}`;

interface FakeChannel {
  id: string;
  handle: string;
  accountId: string | null;
  accountName: string | null;
  specificationHandle: string | null;
}

// Shopify's explicit channel connections for one shop: handles are unique, and
// a specification requirement can refuse creation or rebinding.
function fakeShopify({
  scopes = ["read_products", "read_product_listings"],
  channel = null as FakeChannel | null,
  refuse = null as string | null,
  failOn = null as string | null,
} = {}) {
  const shop = { channel, created: 0 };
  const calls: string[] = [];
  const graphql: GraphqlRequestFn = async (query, variables) => {
    const name = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "unknown";
    calls.push(name);
    if (failOn === name) throw new Error("Network connection lost");
    const input = variables.input as Record<string, string>;
    switch (name) {
      case "AuraChannelAccess":
        return {
          data: {
            currentAppInstallation: {
              accessScopes: scopes.map((handle) => ({ handle })),
            },
          },
        };
      case "AuraChannelConnection":
        return {
          data: {
            channelByHandle:
              shop.channel?.handle === variables.handle ? shop.channel : null,
          },
        };
      case "AuraChannelCreate": {
        const userErrors = refuse
          ? [{ field: ["input"], message: refuse, code: "INVALID" }]
          : shop.channel?.handle === input.handle
            ? [
                {
                  field: ["input", "handle"],
                  message: "Handle has already been taken",
                  code: "INVALID",
                },
              ]
            : [];
        if (!userErrors.length) {
          shop.created++;
          shop.channel = {
            id: `gid://shopify/Channel/${100 + shop.created}`,
            handle: input.handle,
            accountId: input.accountId,
            accountName: input.accountName,
            specificationHandle: input.specificationHandle,
          };
        }
        return {
          data: {
            channelCreate: {
              channel: userErrors.length ? null : shop.channel,
              userErrors,
            },
          },
        };
      }
      case "AuraChannelUpdate": {
        const current = shop.channel;
        if (refuse || current?.id !== variables.id || !current)
          return {
            data: {
              channelUpdate: {
                channel: null,
                userErrors: [{ message: refuse ?? "Not found" }],
              },
            },
          };
        shop.channel = { ...current, ...input };
        return {
          data: { channelUpdate: { channel: shop.channel, userErrors: [] } },
        };
      }
    }
    throw new Error(`Unexpected query ${name}`);
  };
  return { graphql, calls, shop };
}

function existing(overrides: Partial<FakeChannel> = {}): FakeChannel {
  return {
    id: "gid://shopify/Channel/77",
    handle: AURA_CHANNEL_HANDLE,
    accountId: listingSourceId,
    accountName: "Aura Historia",
    specificationHandle: AURA_CHANNEL_SPECIFICATION_HANDLE,
    ...overrides,
  };
}

let warnings: string[];

describe("Aura channel connection lifecycle", () => {
  beforeEach(() => {
    warnings = [];
    mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
  });
  afterEach(() => mock.restoreAll());

  it("binds a fresh installation's connection to the authorized source", async () => {
    const shopify = fakeShopify();
    assert.deepEqual(
      await ensureAuraChannel(shopify.graphql, listingSourceId),
      {
        state: "ready",
        channelId: "gid://shopify/Channel/101",
      },
    );
    assert.deepEqual(shopify.shop.channel, {
      id: "gid://shopify/Channel/101",
      handle: "aura-historia",
      accountId: listingSourceId,
      accountName: "Aura Historia",
      specificationHandle: "aura-historia",
    });
    assert.deepEqual(shopify.calls, [
      "AuraChannelAccess",
      "AuraChannelConnection",
      "AuraChannelCreate",
    ]);
  });

  it("reuses the connection on callback retries and later imports", async () => {
    const shopify = fakeShopify();
    for (let run = 0; run < 3; run++)
      assert.equal(
        (await ensureAuraChannel(shopify.graphql, listingSourceId)).state,
        "ready",
      );
    assert.equal(shopify.shop.created, 1);
    assert.equal(
      shopify.calls.filter((call) => /Create|Update/.test(call)).length,
      1,
    );
  });

  it("rebinds the same connection when another source is connected", async () => {
    const shopify = fakeShopify({ channel: existing() });
    assert.deepEqual(await ensureAuraChannel(shopify.graphql, otherSourceId), {
      state: "ready",
      channelId: "gid://shopify/Channel/77",
    });
    assert.equal(shopify.shop.channel?.accountId, otherSourceId);
    assert.equal(shopify.shop.created, 0);
    assert.ok(shopify.calls.includes("AuraChannelUpdate"));
  });

  it("assigns the specification to a connection that lacks it", async () => {
    const shopify = fakeShopify({
      channel: existing({ specificationHandle: null, accountId: null }),
    });
    assert.equal(
      (await ensureAuraChannel(shopify.graphql, listingSourceId)).state,
      "ready",
    );
    assert.equal(
      shopify.shop.channel?.specificationHandle,
      AURA_CHANNEL_SPECIFICATION_HANDLE,
    );
    assert.equal(shopify.shop.created, 0);
  });

  it("adopts a connection created concurrently instead of duplicating it", async () => {
    const shopify = fakeShopify();
    let raced = false;
    // Another callback or import creates the handle between this read and
    // this create.
    const graphql: GraphqlRequestFn = async (query, variables) => {
      if (query.includes("AuraChannelCreate") && !raced) {
        raced = true;
        await shopify.graphql(query, variables);
      }
      return shopify.graphql(query, variables);
    };
    assert.deepEqual(await ensureAuraChannel(graphql, listingSourceId), {
      state: "ready",
      channelId: "gid://shopify/Channel/101",
    });
    assert.equal(shopify.shop.created, 1);
    assert.equal(shopify.calls.includes("AuraChannelUpdate"), false);
  });

  it("reports a refused connection without retrying or claiming success", async () => {
    const shopify = fakeShopify({
      refuse: "Channel specification aura-historia was not found",
    });
    assert.deepEqual(
      await ensureAuraChannel(shopify.graphql, listingSourceId),
      {
        state: "rejected",
      },
    );
    assert.equal(shopify.shop.channel, null);
    assert.equal(
      shopify.calls.filter((call) => call === "AuraChannelCreate").length,
      1,
    );
    assert.match(warnings.join("\n"), /aura-historia was not found/);
  });

  it("reports a refused rebinding", async () => {
    const shopify = fakeShopify({
      channel: existing({ accountId: otherSourceId }),
      refuse: "Invalid specification",
    });
    assert.deepEqual(
      await ensureAuraChannel(shopify.graphql, listingSourceId),
      {
        state: "rejected",
      },
    );
    assert.equal(shopify.shop.channel?.accountId, otherSourceId);
  });

  it("requires the granted product listing scope before any channel write", async () => {
    const shopify = fakeShopify({ scopes: ["read_products"] });
    assert.deepEqual(
      await ensureAuraChannel(shopify.graphql, listingSourceId),
      {
        state: "missing_scope",
      },
    );
    assert.deepEqual(shopify.calls, ["AuraChannelAccess"]);
  });

  it("treats failed or malformed provisioning as retryable, never ready", async () => {
    for (const failOn of [
      "AuraChannelAccess",
      "AuraChannelConnection",
      "AuraChannelCreate",
    ]) {
      const shopify = fakeShopify({ failOn });
      assert.deepEqual(
        await ensureAuraChannel(shopify.graphql, listingSourceId),
        { state: "unavailable" },
        failOn,
      );
    }
    for (const payload of [
      { channelCreate: null },
      { channelCreate: { channel: null, userErrors: [] } },
      {
        channelCreate: {
          channel: { ...existing(), accountId: otherSourceId },
          userErrors: [],
        },
      },
      { channelCreate: { channel: { id: "untrusted" }, userErrors: [] } },
    ]) {
      const graphql: GraphqlRequestFn = async (query, variables) =>
        query.includes("AuraChannelCreate")
          ? { data: payload }
          : fakeShopify().graphql(query, variables);
      assert.deepEqual(await ensureAuraChannel(graphql, listingSourceId), {
        state: "unavailable",
      });
    }
  });

  it("never duplicates the connection across uninstall and reinstall", async () => {
    const shopify = fakeShopify();
    await ensureAuraChannel(shopify.graphql, listingSourceId);
    // A connection that outlived the installation is reused.
    await ensureAuraChannel(shopify.graphql, listingSourceId);
    assert.equal(shopify.shop.created, 1);
    // One removed with the installation is created again on the next connect.
    shopify.shop.channel = null;
    await ensureAuraChannel(shopify.graphql, listingSourceId);
    await ensureAuraChannel(shopify.graphql, listingSourceId);
    assert.equal(shopify.shop.created, 2);
    assert.equal(
      (shopify.shop.channel as FakeChannel | null)?.id,
      "gid://shopify/Channel/102",
    );
  });
});

function catalogPage(
  catalogs: Array<{ id: unknown; channels: string[]; more?: boolean }>,
  hasNextPage = false,
  endCursor: unknown = "next",
) {
  return {
    data: {
      catalogs: {
        nodes: catalogs.map(({ id, channels, more = false }) => ({
          id,
          channels: {
            nodes: channels.map((channel) => ({ id: channel })),
            pageInfo: { hasNextPage: more },
          },
        })),
        pageInfo: { hasNextPage, endCursor },
      },
    },
  };
}

describe("Aura channel publication lookup", () => {
  const channel = "gid://shopify/Channel/77";
  const own = { id: "gid://shopify/AppCatalog/77", channels: [channel] };
  // The other app catalogs of the QA store: Online Store, Point of Sale and
  // Shop.
  const others = [1, 2, 3].map((n) => ({
    id: `gid://shopify/AppCatalog/${n}`,
    channels: [`gid://shopify/Channel/${n}`],
  }));
  const ownPublication = {
    data: {
      catalog: {
        publication: { id: "gid://shopify/Publication/77" },
        channels: {
          nodes: [{ id: channel }],
          pageInfo: { hasNextPage: false },
        },
      },
    },
  };

  // Shopify 2026-10 as observed on a fresh installation without
  // `read_publications`: catalog identity and channels are readable on every
  // app catalog, the publication field only with that scope. Publications are
  // served for the app's own catalog only.
  function catalogShop(
    pages: unknown[],
    read: () => unknown = () => ownPublication,
  ) {
    const afters: unknown[] = [];
    const reads: unknown[] = [];
    const graphql: GraphqlRequestFn = async (query, variables) => {
      if (query.includes("AuraChannelCatalogs")) {
        assert.match(query, /catalogs\(type: APP/);
        assert.doesNotMatch(query, /publication/);
        afters.push(variables.after);
        return pages[afters.length - 1] as Awaited<
          ReturnType<GraphqlRequestFn>
        >;
      }
      assert.match(query, /AuraChannelCatalogPublication/);
      reads.push(variables.id);
      if (variables.id !== own.id)
        return {
          errors: [
            {
              message: "Access denied for publication field.",
              extensions: { code: "ACCESS_DENIED" },
            },
          ],
        };
      return read() as Awaited<ReturnType<GraphqlRequestFn>>;
    };
    return { graphql, afters, reads };
  }

  it("pages through app catalogs and reads only its own catalog's publication", async () => {
    const shop = catalogShop([
      catalogPage(others, true, "cursor-1"),
      catalogPage([own]),
    ]);
    assert.deepEqual(await findChannelPublication(shop.graphql, channel), {
      state: "ready",
      publicationId: "gid://shopify/Publication/77",
    });
    assert.deepEqual(shop.afters, [null, "cursor-1"]);
    assert.deepEqual(shop.reads, [own.id]);
  });

  it("finds its catalog among other app catalogs in any position", async () => {
    for (const catalogs of [
      [own, ...others],
      [...others.slice(0, 2), own, others[2]],
      [own],
    ]) {
      const shop = catalogShop([catalogPage(catalogs)]);
      assert.deepEqual(await findChannelPublication(shop.graphql, channel), {
        state: "ready",
        publicationId: "gid://shopify/Publication/77",
      });
      assert.deepEqual(shop.reads, [own.id]);
    }
  });

  it("reports a missing publication only after a complete scan", async () => {
    const complete = catalogShop([catalogPage(others)]);
    assert.deepEqual(await findChannelPublication(complete.graphql, channel), {
      state: "missing",
    });
    assert.deepEqual(complete.reads, []);
    assert.deepEqual(
      await findChannelPublication(
        catalogShop([catalogPage([{ ...others[0], more: true }])]).graphql,
        channel,
      ),
      { state: "unavailable" },
    );
  });

  it("never trusts ambiguous, malformed, failed or unbounded scans", async () => {
    for (const pages of [
      [catalogPage([own, { ...own, id: "gid://shopify/AppCatalog/78" }])],
      [catalogPage([{ ...own, id: "gid://shopify/Publication/77" }])],
      [catalogPage([{ ...own, id: null }])],
      [
        {
          data: {
            catalogs: {
              nodes: [{ id: own.id }],
              pageInfo: { hasNextPage: false, endCursor: "end" },
            },
          },
        },
      ],
      [catalogPage(others, true, null)],
      [catalogPage(others, true)],
      [{ data: {} }],
      [{ errors: [{ message: "Throttled" }] }],
    ]) {
      const shop = catalogShop(pages);
      assert.deepEqual(await findChannelPublication(shop.graphql, channel), {
        state: "unavailable",
      });
      assert.deepEqual(shop.reads, []);
    }
    assert.deepEqual(
      await findChannelPublication(async () => {
        throw new Error("Network connection lost");
      }, channel),
      { state: "unavailable" },
    );
  });

  it("logs Shopify's reason for a failed publication read", async () => {
    const warnings: string[] = [];
    mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      for (const read of [
        () => ({
          errors: [
            {
              message: "Access denied for publication field.",
              extensions: { code: "ACCESS_DENIED" },
            },
          ],
        }),
        // The offline Admin client raises GraphQL errors.
        () => {
          throw new Error("Access denied for publication field.");
        },
      ]) {
        const shop = catalogShop([catalogPage([own])], read);
        assert.deepEqual(await findChannelPublication(shop.graphql, channel), {
          state: "unavailable",
        });
      }
    } finally {
      mock.restoreAll();
    }
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /ACCESS_DENIED Access denied for publication/);
    assert.match(warnings[1], /Access denied for publication field/);
  });

  it("never trusts a denied, malformed or changed publication read", async () => {
    const catalog = ownPublication.data.catalog;
    for (const read of [
      // Without `read_publications` Shopify denies the field.
      () => ({
        data: { catalog: { ...catalog, publication: null } },
        errors: [
          {
            message: "Access denied for publication field.",
            extensions: { code: "ACCESS_DENIED" },
          },
        ],
      }),
      () => ({ data: { catalog: { ...catalog, publication: {} } } }),
      () => ({ data: { catalog: { ...catalog, publication: undefined } } }),
      () => ({
        data: { catalog: { ...catalog, publication: { id: "untrusted" } } },
      }),
      () => ({ data: { catalog: null } }),
      // The catalog no longer lists the channel.
      () => ({
        data: {
          catalog: {
            ...catalog,
            channels: { nodes: [], pageInfo: { hasNextPage: false } },
          },
        },
      }),
      () => ({ data: {} }),
      () => {
        throw new Error("Network connection lost");
      },
    ]) {
      const shop = catalogShop([catalogPage([...others, own])], read);
      assert.deepEqual(await findChannelPublication(shop.graphql, channel), {
        state: "unavailable",
      });
      assert.deepEqual(shop.reads, [own.id]);
    }
  });

  it("reports a catalog that lists the connection without a publication as missing", async () => {
    // As right after the connection was set up (#405): Shopify answers the
    // granted field without an error, but with no publication yet.
    const catalog = ownPublication.data.catalog;
    const shop = catalogShop([catalogPage([...others, own])], () => ({
      data: { catalog: { ...catalog, publication: null } },
    }));
    assert.deepEqual(await findChannelPublication(shop.graphql, channel), {
      state: "missing",
    });
    assert.deepEqual(shop.reads, [own.id]);
  });
});

describe("Shopify access for the channel and its publication", () => {
  const granting =
    (handles: string[]): GraphqlRequestFn =>
    async () => ({
      data: {
        currentAppInstallation: {
          accessScopes: handles.map((handle) => ({ handle })),
        },
      },
    });

  it("requires publication access for publication reads only", async () => {
    for (const [scopes, listing, catalog] of [
      // Installations approved before `read_publications` was required.
      [["read_products", "read_product_listings"], "granted", "missing"],
      [
        ["read_products", "read_product_listings", "read_publications"],
        "granted",
        "granted",
      ],
      [["write_product_listings", "write_publications"], "granted", "granted"],
      [["read_products", "read_publications"], "missing", "missing"],
      [[], "missing", "missing"],
    ] as const) {
      assert.equal(await readListingAccess(granting([...scopes])), listing);
      assert.equal(await readCatalogAccess(granting([...scopes])), catalog);
    }
  });

  it("reports unreadable access as unavailable, never as missing", async () => {
    for (const graphql of [
      async () => ({ errors: [{ message: "Throttled" }] }),
      async () => ({ data: { currentAppInstallation: {} } }),
      async () => {
        throw new Error("Network connection lost");
      },
    ] as GraphqlRequestFn[]) {
      assert.equal(await readListingAccess(graphql), "unavailable");
      assert.equal(await readCatalogAccess(graphql), "unavailable");
    }
  });
});

describe("Aura channel configuration", () => {
  it("creates connections for the deployed specification", () => {
    const spec = readFileSync(
      resolve(
        process.cwd(),
        "extensions/channel-config/specifications/aura-historia.toml",
      ),
      "utf8",
    );
    assert.equal(
      /^handle = "([^"]+)"/m.exec(spec)?.[1],
      AURA_CHANNEL_SPECIFICATION_HANDLE,
    );
  });
});
