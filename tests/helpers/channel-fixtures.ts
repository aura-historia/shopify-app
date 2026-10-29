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
// fields: without `read_publications` Shopify denies them, and this fixture
// serves one only for the channel's own catalog.
export function channelResponse(
  query: string,
  {
    scopes = grantedScopes,
    channel = boundChannel(),
    publication = { id: "gid://shopify/Publication/456" },
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
  const listed =
    channel && typeof channel === "object" && "id" in channel
      ? (channel as { id: unknown }).id
      : channelId;
  if (query.includes("AuraChannelCatalogs")) {
    if (publication instanceof Error) throw publication;
    return {
      data: {
        catalogs: {
          nodes: [
            // Another app's catalog, such as the Online Store's.
            {
              id: "gid://shopify/AppCatalog/9001",
              channels: listing("gid://shopify/Channel/9001"),
            },
            ...(publication === null
              ? []
              : [{ id: channelCatalogId, channels: listing(listed) }]),
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
      return {
        data: { catalog: { publication: null, channels: listing(listed) } },
        errors: [
          {
            message: "Access denied for publication field.",
            extensions: { code: "ACCESS_DENIED" },
            path: ["catalog", "publication"],
          },
        ],
      };
    return { data: { catalog: { publication, channels: listing(listed) } } };
  }
  throw new Error(`Unexpected channel query: ${query.slice(0, 60)}`);
}

export function channelGraphql(state: ChannelState = {}): GraphqlRequestFn {
  return async (query, variables) => channelResponse(query, state, variables);
}
