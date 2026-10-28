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
      refuse:
        "Channel specification requires online store parity but countries AC, AD do not have matching region markets",
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
    assert.match(warnings.join("\n"), /requires online store parity/);
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
  catalogs: Array<{
    publication: unknown;
    channels: string[];
    more?: boolean;
  }>,
  hasNextPage = false,
  endCursor: unknown = "next",
) {
  return {
    data: {
      catalogs: {
        nodes: catalogs.map(({ publication, channels, more = false }) => ({
          publication,
          channels: {
            nodes: channels.map((id) => ({ id })),
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
  const online = {
    publication: { id: "gid://shopify/Publication/1" },
    channels: ["gid://shopify/Channel/1"],
  };

  it("pages through app catalogs to the channel's publication", async () => {
    const afters: unknown[] = [];
    const pages = [
      catalogPage([online], true, "cursor-1"),
      catalogPage([
        {
          publication: { id: "gid://shopify/Publication/77" },
          channels: [channel],
        },
      ]),
    ];
    assert.deepEqual(
      await findChannelPublication(async (query, variables) => {
        assert.match(query, /catalogs\(type: APP/);
        afters.push(variables.after);
        return pages[afters.length - 1];
      }, channel),
      { state: "ready", publicationId: "gid://shopify/Publication/77" },
    );
    assert.deepEqual(afters, [null, "cursor-1"]);
  });

  it("reports a missing publication only after a complete scan", async () => {
    assert.deepEqual(
      await findChannelPublication(async () => catalogPage([online]), channel),
      { state: "missing" },
    );
    assert.deepEqual(
      await findChannelPublication(
        async () => catalogPage([{ ...online, more: true }]),
        channel,
      ),
      { state: "unavailable" },
    );
  });

  it("never trusts ambiguous, malformed, failed or unbounded scans", async () => {
    for (const graphql of [
      async () =>
        catalogPage([
          {
            publication: { id: "gid://shopify/Publication/2" },
            channels: [channel],
          },
          {
            publication: { id: "gid://shopify/Publication/3" },
            channels: [channel],
          },
        ]),
      async () =>
        catalogPage([
          { publication: { id: "untrusted" }, channels: [channel] },
        ]),
      async () => catalogPage([{ publication: null, channels: [channel] }]),
      async () => ({
        data: {
          catalogs: {
            nodes: [{ publication: { id: "gid://shopify/Publication/1" } }],
            pageInfo: { hasNextPage: false, endCursor: "end" },
          },
        },
      }),
      async () => catalogPage([online], true, null),
      async () => catalogPage([online], true),
      async () => ({ data: {} }),
      async () => ({ errors: [{ message: "Throttled" }] }),
      async () => {
        throw new Error("Network connection lost");
      },
    ] as GraphqlRequestFn[]) {
      assert.deepEqual(await findChannelPublication(graphql, channel), {
        state: "unavailable",
      });
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

  it("keeps Shopify's legacy install-time channel disabled", () => {
    const extension = readFileSync(
      resolve(
        process.cwd(),
        "extensions/channel-config/shopify.extension.toml",
      ),
      "utf8",
    );
    assert.match(extension, /^create_legacy_channel_on_app_install = false$/m);
    assert.match(extension, /channelCreate/);
  });
});
