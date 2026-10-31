import type { GraphqlRequestFn } from "./backfill.server";

// One explicit channel connection per installation. The handle is fixed, so a
// retried callback, a reconnect or a concurrent import finds the connection it
// created instead of creating another one. The specification handle must match
// `extensions/channel-config/specifications/aura-historia.toml`.
export const AURA_CHANNEL_HANDLE = "aura-historia";
export const AURA_CHANNEL_SPECIFICATION_HANDLE = "aura-historia";
const AURA_CHANNEL_ACCOUNT_NAME = "Aura Historia";

const CHANNEL_GID = /^gid:\/\/shopify\/Channel\/([1-9]\d*)$/;
const APP_CATALOG_GID = /^gid:\/\/shopify\/AppCatalog\/([1-9]\d*)$/;
export const PUBLICATION_GID = /^gid:\/\/shopify\/Publication\/([1-9]\d*)$/;

// Shopify scope for the app's own channel listings: channel connections and
// the listing webhooks depend on it. The write scope implies it.
const PRODUCT_LISTINGS_SCOPES = [
  "read_product_listings",
  "write_product_listings",
];
// Shopify scope for publication fields: Shopify denies the publication of the
// channel's app catalog without it, and its access-scope reference places
// products' publication fields, such as the `publishedOnPublication`
// membership, under it as well. The write scope implies it.
const PUBLICATIONS_SCOPES = ["read_publications", "write_publications"];

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
async function readAccess(
  graphql: GraphqlRequestFn,
  required: string[][],
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
    const handles = new Set(
      granted.map((scope: { handle?: unknown } | null) => scope?.handle),
    );
    return required.every((scopes) =>
      scopes.some((scope) => handles.has(scope)),
    )
      ? "granted"
      : "missing";
  } catch {
    return "unavailable";
  }
}

// Access to create, rebind and receive the listings of the channel connection.
export function readListingAccess(
  graphql: GraphqlRequestFn,
): Promise<ListingAccess> {
  return readAccess(graphql, [PRODUCT_LISTINGS_SCOPES]);
}

// Access to resolve the connection's publication and read every product's
// membership in it. Installations approved before `read_publications` was
// required lack it until the merchant approves the updated access.
export function readCatalogAccess(
  graphql: GraphqlRequestFn,
): Promise<ListingAccess> {
  return readAccess(graphql, [PRODUCT_LISTINGS_SCOPES, PUBLICATIONS_SCOPES]);
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

interface CatalogChannels {
  nodes?: Array<{ id?: unknown } | null>;
  pageInfo?: { hasNextPage?: unknown };
}

interface CatalogPage {
  catalogs?: {
    nodes?: Array<{ id?: unknown; channels?: CatalogChannels } | null>;
    pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
  };
}

interface CatalogPublication {
  catalog?: {
    publication?: { id?: unknown } | null;
    channels?: CatalogChannels;
  } | null;
}

// Shopify's error text names the failed or denied field, never credentials,
// so a failed publication read stays diagnosable in the Worker log.
function warnPublicationRead(error: unknown) {
  const text = Array.isArray(error)
    ? error
        .map(
          (
            entry: {
              message?: unknown;
              extensions?: { code?: unknown };
            } | null,
          ) => `${entry?.extensions?.code ?? "ERROR"} ${entry?.message ?? ""}`,
        )
        .join("; ")
    : error instanceof Error
      ? error.message
      : String(error);
  console.warn(
    "Shopify channel publication read failed:",
    text.replace(/\s+/g, " ").slice(0, 300),
  );
}

// Whether a catalog lists the channel. Unreadable or cut-off channels are
// unknown: such a catalog might list it.
function listsChannel(
  channels: CatalogChannels | undefined,
  channelId: string,
): boolean | undefined {
  if (!Array.isArray(channels?.nodes)) return undefined;
  if (channels.nodes.some((channel) => channel?.id === channelId)) return true;
  return channels.pageInfo?.hasNextPage === false ? false : undefined;
}

// Finds the one app catalog that lists the channel. The scan reads only
// catalog identity and channels, which every app catalog exposes to this app,
// so other apps' catalogs never fail the lookup.
async function findChannelCatalog(
  graphql: GraphqlRequestFn,
  channelId: string,
): Promise<
  | { state: "ready"; catalogId: string }
  | Exclude<ChannelPublicationLookup, { state: "ready" }>
> {
  const found = new Set<string>();
  let truncated = false;
  let after: string | null = null;
  for (let page = 0; page < CATALOG_MAX_PAGES; page++) {
    const response = await graphql(
      `query AuraChannelCatalogs($first: Int!, $after: String) {
      catalogs(type: APP, first: $first, after: $after) {
        nodes {
          id
          ... on AppCatalog {
            channels(first: 10) { nodes { id } pageInfo { hasNextPage } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
      { first: CATALOG_PAGE_SIZE, after },
    );
    const catalogs = (response.data as CatalogPage | undefined)?.catalogs;
    if (response.errors) warnPublicationRead(response.errors);
    if (response.errors || !Array.isArray(catalogs?.nodes))
      return { state: "unavailable" };
    for (const catalog of catalogs.nodes) {
      const listed = listsChannel(catalog?.channels, channelId);
      // An unknown catalog rules out a confirmed missing publication.
      if (listed === undefined) truncated = true;
      else if (listed) {
        if (
          typeof catalog?.id !== "string" ||
          !APP_CATALOG_GID.test(catalog.id)
        )
          return { state: "unavailable" };
        found.add(catalog.id);
      }
    }
    const next = catalogs.pageInfo;
    if (next?.hasNextPage === false) {
      // One channel belongs to exactly one app catalog; anything else is not
      // a trustworthy selection.
      if (found.size === 1) return { state: "ready", catalogId: [...found][0] };
      return found.size === 0 && !truncated
        ? { state: "missing" }
        : { state: "unavailable" };
    }
    if (typeof next?.endCursor !== "string") return { state: "unavailable" };
    after = next.endCursor;
  }
  return { state: "unavailable" };
}

// `currentAppInstallation.publication` is deprecated in 2026-10 and does not
// identify an explicit channel connection. The app catalog that lists this
// channel holds the publication the merchant's product selection is recorded
// on. Its `publication` field needs `read_publications` and is read on that
// catalog only.
export async function findChannelPublication(
  graphql: GraphqlRequestFn,
  channelId: string,
): Promise<ChannelPublicationLookup> {
  try {
    const lookup = await findChannelCatalog(graphql, channelId);
    if (lookup.state !== "ready") return lookup;
    const response = await graphql(
      `query AuraChannelCatalogPublication($id: ID!) {
      catalog(id: $id) {
        ... on AppCatalog {
          publication { id }
          channels(first: 10) { nodes { id } pageInfo { hasNextPage } }
        }
      }
    }`,
      { id: lookup.catalogId },
    );
    const catalog = (response.data as CatalogPublication | undefined)?.catalog;
    if (response.errors) warnPublicationRead(response.errors);
    // The catalog must still list the channel when its publication is read.
    if (response.errors || listsChannel(catalog?.channels, channelId) !== true)
      return { state: "unavailable" };
    // The connection's catalog has no publication (yet), which Shopify
    // answers with an explicit null. Anything else unexpected is unreadable.
    if (catalog?.publication === null) return { state: "missing" };
    const id = catalog?.publication?.id;
    return typeof id === "string" && PUBLICATION_GID.test(id)
      ? { state: "ready", publicationId: id }
      : { state: "unavailable" };
  } catch (error) {
    // The offline Admin client throws on any GraphQL error, such as a denial.
    warnPublicationRead(error);
    return { state: "unavailable" };
  }
}
