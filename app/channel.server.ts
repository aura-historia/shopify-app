import type { GraphqlRequestFn } from "./backfill.server";

// One explicit channel connection per installation. The handle is fixed, so a
// retried callback, a reconnect or a concurrent import finds the connection it
// created instead of creating another one. The specification handle must match
// `extensions/channel-config/specifications/aura-historia.toml`.
export const AURA_CHANNEL_HANDLE = "aura-historia";
export const AURA_CHANNEL_SPECIFICATION_HANDLE = "aura-historia";
const AURA_CHANNEL_ACCOUNT_NAME = "Aura Historia";

const CHANNEL_GID = /^gid:\/\/shopify\/Channel\/([1-9]\d*)$/;
export const PUBLICATION_GID = /^gid:\/\/shopify\/Publication\/([1-9]\d*)$/;

// Shopify scope for the app's own channel listings: channel connections, the
// listing webhooks and per-publication membership reads depend on it. The
// write scope implies it.
const PRODUCT_LISTINGS_SCOPES = new Set([
  "read_product_listings",
  "write_product_listings",
]);

// Bounds the app catalog scan: 20 pages of 25 catalogs.
const CATALOG_PAGE_SIZE = 25;
const CATALOG_MAX_PAGES = 20;

export interface AuraChannel {
  id: string;
  accountId: string | null;
  specificationHandle: string | null;
  productsCount?: { count?: unknown; precision?: unknown } | null;
}

interface ChannelUserError {
  field?: unknown;
  message?: unknown;
  code?: unknown;
}

export type ListingAccess = "granted" | "missing" | "unavailable";

// Verifies the access actually granted to this installation: a changed
// configuration is not proof that the merchant approved the new scope.
// Scopes are read on their own because the Admin client throws on any GraphQL
// error, which would hide a denial behind a generic failure.
export async function readListingAccess(
  graphql: GraphqlRequestFn,
): Promise<ListingAccess> {
  try {
    const response = await graphql(
      `query AuraChannelAccess {
      currentAppInstallation { accessScopes { handle } }
    }`,
      {},
    );
    const granted = (
      response.data as
        | { currentAppInstallation?: { accessScopes?: unknown } }
        | undefined
    )?.currentAppInstallation?.accessScopes;
    if (response.errors || !Array.isArray(granted)) return "unavailable";
    return granted.some(
      (scope: { handle?: unknown } | null) =>
        typeof scope?.handle === "string" &&
        PRODUCT_LISTINGS_SCOPES.has(scope.handle),
    )
      ? "granted"
      : "missing";
  } catch {
    return "unavailable";
  }
}

function parseChannel(value: unknown): AuraChannel | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const channel = value as Record<string, unknown>;
  const optionalString = (field: unknown) =>
    field === null || typeof field === "string";
  if (
    typeof channel.id !== "string" ||
    !CHANNEL_GID.test(channel.id) ||
    !optionalString(channel.accountId) ||
    !optionalString(channel.specificationHandle)
  )
    return undefined;
  return channel as unknown as AuraChannel;
}

// Reads this app's channel connection by its stable handle. `null` means the
// installation has no connection; `undefined` means the read failed.
export async function readAuraChannel(
  graphql: GraphqlRequestFn,
  includeCount = false,
): Promise<AuraChannel | null | undefined> {
  try {
    const response = await graphql(
      `query AuraChannelConnection($handle: String!) {
      channelByHandle(handle: $handle) {
        id
        accountId
        specificationHandle
        ${includeCount ? 'productsCount(query: "status:active") { count precision }' : ""}
      }
    }`,
      { handle: AURA_CHANNEL_HANDLE },
    );
    if (response.errors) return undefined;
    return parseChannel(
      (response.data as { channelByHandle?: unknown } | undefined)
        ?.channelByHandle,
    );
  } catch {
    return undefined;
  }
}

export type ChannelProvisioning =
  | { state: "ready"; channelId: string }
  | { state: "missing_scope" }
  // Shopify refused the connection with `userErrors`, for example because the
  // specification is not deployed.
  | { state: "rejected" }
  | { state: "unavailable" };

const CHANNEL_FIELDS = "channel { id accountId specificationHandle }";

async function writeChannel(
  graphql: GraphqlRequestFn,
  existing: AuraChannel | null,
  listingSourceId: string,
): Promise<ChannelProvisioning | "conflict"> {
  const mutation = existing ? "channelUpdate" : "channelCreate";
  const response = existing
    ? await graphql(
        `mutation AuraChannelUpdate($id: ID!, $input: ChannelUpdateInput!) {
      channelUpdate(id: $id, input: $input) {
        ${CHANNEL_FIELDS}
        userErrors { field message code }
      }
    }`,
        {
          id: existing.id,
          input: {
            accountId: listingSourceId,
            accountName: AURA_CHANNEL_ACCOUNT_NAME,
            specificationHandle: AURA_CHANNEL_SPECIFICATION_HANDLE,
          },
        },
      )
    : await graphql(
        `mutation AuraChannelCreate($input: ChannelCreateInput!) {
      channelCreate(input: $input) {
        ${CHANNEL_FIELDS}
        userErrors { field message code }
      }
    }`,
        {
          input: {
            handle: AURA_CHANNEL_HANDLE,
            specificationHandle: AURA_CHANNEL_SPECIFICATION_HANDLE,
            accountId: listingSourceId,
            accountName: AURA_CHANNEL_ACCOUNT_NAME,
          },
        },
      );
  if (response.errors) return { state: "unavailable" };
  const payload = (
    response.data as
      | Record<string, { channel?: unknown; userErrors?: unknown } | undefined>
      | undefined
  )?.[mutation];
  const userErrors = payload?.userErrors;
  if (!Array.isArray(userErrors)) return { state: "unavailable" };
  if (userErrors.length > 0) {
    // Shopify's validation text names configuration, never credentials.
    console.warn(
      `Shopify ${mutation} rejected the Aura Historia channel:`,
      (userErrors as ChannelUserError[])
        .map((error) => `${error.code ?? "INVALID"} ${error.message ?? ""}`)
        .join("; ")
        .replace(/\s+/g, " ")
        .slice(0, 300),
    );
    // A concurrent callback or import may have created the same handle.
    return existing ? { state: "rejected" } : "conflict";
  }
  const channel = parseChannel(payload?.channel);
  return isBoundChannel(channel, listingSourceId)
    ? { state: "ready", channelId: channel.id }
    : { state: "unavailable" };
}

// The connection represents the authorized Aura listing source under this
// app's specification.
export function isBoundChannel(
  channel: AuraChannel | null | undefined,
  listingSourceId: string,
): channel is AuraChannel {
  return (
    channel?.accountId === listingSourceId &&
    channel.specificationHandle === AURA_CHANNEL_SPECIFICATION_HANDLE
  );
}

// Idempotently binds this installation's channel connection to the validated,
// authorized Aura listing source. Run only after Aura accepted the source's
// ingestion configuration with the merchant's token.
export async function ensureAuraChannel(
  graphql: GraphqlRequestFn,
  listingSourceId: string,
): Promise<ChannelProvisioning> {
  const access = await readListingAccess(graphql);
  if (access !== "granted")
    return { state: access === "missing" ? "missing_scope" : "unavailable" };
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await readAuraChannel(graphql);
      if (existing === undefined) return { state: "unavailable" };
      if (isBoundChannel(existing, listingSourceId))
        return { state: "ready", channelId: existing.id };
      // A refused creation is retried only when a concurrent writer created
      // the handle in the meantime.
      if (attempt > 0 && existing === null) break;
      // Reconnecting another source rebinds the same connection, keeping the
      // merchant's product selection; no second channel is created.
      const result = await writeChannel(graphql, existing, listingSourceId);
      if (result !== "conflict") return result;
    }
    return { state: "rejected" };
  } catch {
    return { state: "unavailable" };
  }
}

export type ChannelPublicationLookup =
  | { state: "ready"; publicationId: string }
  | { state: "missing" }
  | { state: "unavailable" };

interface CatalogPage {
  catalogs?: {
    nodes?: Array<{
      publication?: { id?: unknown } | null;
      channels?: {
        nodes?: Array<{ id?: unknown }>;
        pageInfo?: { hasNextPage?: unknown };
      };
    }>;
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
  };
}

// `currentAppInstallation.publication` is deprecated in 2026-10 and does not
// identify an explicit channel connection; the `publications` successor needs
// `read_publications`, which is not requested. The app catalog that lists this
// channel holds the publication the merchant's product selection is recorded
// on.
export async function findChannelPublication(
  graphql: GraphqlRequestFn,
  channelId: string,
): Promise<ChannelPublicationLookup> {
  try {
    const found = new Set<string>();
    let truncated = false;
    let after: string | null = null;
    for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
      const response = await graphql(
        `query AuraChannelPublication($first: Int!, $after: String) {
        catalogs(type: APP, first: $first, after: $after) {
          nodes {
            ... on AppCatalog {
              publication { id }
              channels(first: 10) { nodes { id } pageInfo { hasNextPage } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
        { first: CATALOG_PAGE_SIZE, after },
      );
      const catalogs = (response.data as CatalogPage | undefined)?.catalogs;
      if (response.errors || !Array.isArray(catalogs?.nodes))
        return { state: "unavailable" };
      for (const catalog of catalogs.nodes) {
        const channels = catalog?.channels;
        // A catalog whose channels are unreadable or cut off might list this
        // channel, so it rules out a confirmed missing publication.
        if (!Array.isArray(channels?.nodes)) {
          truncated = true;
        } else if (
          channels.nodes.some((channel) => channel?.id === channelId)
        ) {
          const id = catalog.publication?.id;
          if (typeof id !== "string" || !PUBLICATION_GID.test(id))
            return { state: "unavailable" };
          found.add(id);
        } else if (channels.pageInfo?.hasNextPage !== false) {
          truncated = true;
        }
      }
      const next = catalogs.pageInfo;
      if (next?.hasNextPage === false) {
        // One channel belongs to exactly one publication; anything else is
        // not a trustworthy selection.
        if (found.size === 1)
          return { state: "ready", publicationId: [...found][0] };
        return found.size === 0 && !truncated
          ? { state: "missing" }
          : { state: "unavailable" };
      }
      if (typeof next?.endCursor !== "string") return { state: "unavailable" };
      after = next.endCursor;
    }
    return { state: "unavailable" };
  } catch {
    return { state: "unavailable" };
  }
}
