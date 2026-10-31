import type { GraphqlRequestFn } from "../../app/backfill.server";

export const channelListingSourceId = `ls_${"0".repeat(26)}`;
export const channelId = "gid://shopify/Channel/321";
// The app catalog Shopify created for the channel connection.
export const channelCatalogId = "gid://shopify/AppCatalog/654";

// Scopes of a fresh installation of the current configuration.
export const grantedScopes = [
  "read_products",
  "read_product_listings",
  "read_publications",
];

type GraphqlResponse = Awaited<ReturnType<GraphqlRequestFn>>;

export interface ChannelState {
  scopes?: string[];
  // `channelByHandle` result; an Error makes the read throw.
  channel?: unknown;
  // Publication of the app catalog listing the channel; `null` lists no
  // catalog for the channel and an Error makes the catalog reads throw.
  publication?: unknown;
  // An app catalog lists the channel although its publication is `null`.
  listed?: boolean;
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
  /AuraChannel(Access|Connection|Catalogs|CatalogPublication|Create|Update)\b/.test(
    query,
  );

function listing(id: unknown) {
  return { nodes: [{ id }], pageInfo: { hasNextPage: false } };
}

// Answers this app's channel reads as Shopify 2026-10 shapes them: granted
// scopes, the explicit connection by handle and the app catalogs listing it.
// Another app's catalog is always present. Publications are publication
// fields: without `read_publications` Shopify denies them, which the offline
// Admin client raises as an error, and this fixture serves one only for the
// channel's own catalog, never in the catalog scan.
export function channelResponse(
  query: string,
  {
    scopes = grantedScopes,
    channel = boundChannel(),
    publication = { id: "gid://shopify/Publication/456" },
    listed = publication !== null,
  }: ChannelState,
  variables: Record<string, unknown>,
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
  const listedChannel =
    channel && typeof channel === "object" && "id" in channel
      ? (channel as { id: unknown }).id
      : channelId;
  if (query.includes("AuraChannelCatalogs")) {
    if (publication instanceof Error) throw publication;
    if (/publication/.test(query))
      throw new Error("Publication read outside the app's own catalog");
    return {
      data: {
        catalogs: {
          nodes: [
            // Another app's catalog, such as the Online Store's.
            {
              id: "gid://shopify/AppCatalog/9001",
              channels: listing("gid://shopify/Channel/9001"),
            },
            ...(listed
              ? [{ id: channelCatalogId, channels: listing(listedChannel) }]
              : []),
          ],
          pageInfo: { hasNextPage: false, endCursor: "end" },
        },
      },
    };
  }
  if (query.includes("AuraChannelCatalogPublication")) {
    if (publication instanceof Error) throw publication;
    if (variables.id !== channelCatalogId)
      throw new Error(`Unexpected publication read of ${String(variables.id)}`);
    if (
      !scopes.includes("read_publications") &&
      !scopes.includes("write_publications")
    )
      throw new Error("Access denied for publication field.");
    return {
      data: { catalog: { publication, channels: listing(listedChannel) } },
    };
  }
  throw new Error(`Unexpected channel query: ${query.slice(0, 60)}`);
}

export function channelGraphql(state: ChannelState = {}): GraphqlRequestFn {
  return async (query, variables) => channelResponse(query, state, variables);
}
