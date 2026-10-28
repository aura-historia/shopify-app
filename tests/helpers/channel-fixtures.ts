import type { GraphqlRequestFn } from "../../app/backfill.server";

export const channelListingSourceId = `ls_${"0".repeat(26)}`;
export const channelId = "gid://shopify/Channel/321";

type GraphqlResponse = Awaited<ReturnType<GraphqlRequestFn>>;

export interface ChannelState {
  scopes?: string[];
  // `channelByHandle` result; an Error makes the read throw.
  channel?: unknown;
  // Publication of the app catalog listing the channel; `null` lists no
  // catalog for the channel and an Error makes the catalog read throw.
  publication?: unknown;
}

export function boundChannel(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: channelId,
    accountId: channelListingSourceId,
    specificationHandle: "aura-historia",
    ...overrides,
  };
}

export const isChannelQuery = (query: string) =>
  /AuraChannel(Access|Connection|Publication|Create|Update)\b/.test(query);

// Answers this app's channel reads as Shopify 2026-10 shapes them: granted
// scopes, the explicit connection by handle and the app catalogs listing it.
export function channelResponse(
  query: string,
  {
    scopes = ["read_products", "read_product_listings"],
    channel = boundChannel(),
    publication = { id: "gid://shopify/Publication/456" },
  }: ChannelState = {},
): GraphqlResponse {
  if (query.includes("AuraChannelAccess"))
    return {
      data: {
        currentAppInstallation: {
          accessScopes: scopes.map((handle) => ({ handle })),
        },
      },
    };
  if (query.includes("AuraChannelConnection")) {
    if (channel instanceof Error) throw channel;
    return { data: { channelByHandle: channel } };
  }
  if (query.includes("AuraChannelPublication")) {
    if (publication instanceof Error) throw publication;
    const listed =
      channel && typeof channel === "object" && "id" in channel
        ? (channel as { id: unknown }).id
        : channelId;
    return {
      data: {
        catalogs: {
          nodes: [
            // Another app's catalog, such as the Online Store's.
            {
              publication: { id: "gid://shopify/Publication/9001" },
              channels: {
                nodes: [{ id: "gid://shopify/Channel/9001" }],
                pageInfo: { hasNextPage: false },
              },
            },
            ...(publication === null
              ? []
              : [
                  {
                    publication,
                    channels: {
                      nodes: [{ id: listed }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                ]),
          ],
          pageInfo: { hasNextPage: false, endCursor: "end" },
        },
      },
    };
  }
  throw new Error(`Unexpected channel query: ${query.slice(0, 60)}`);
}

export function channelGraphql(state: ChannelState = {}): GraphqlRequestFn {
  return async (query) => channelResponse(query, state);
}
