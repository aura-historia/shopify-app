import type { GraphqlRequestFn } from "./backfill.server";
import {
  type AuraChannel,
  type ChannelProvisioning,
  findChannelPublication,
  isBoundChannel,
  PUBLICATION_GID,
  readAuraChannel,
  readCatalogAccess,
} from "./channel.server";
import { getShopifyStoreName } from "./shopify-admin-url";

type KV = Pick<CloudflareBindings["KV"], "get" | "put" | "delete">;
const STATUS_PREFIX = "aura-historia:catalog-status:";

export const CATALOG_IMPORT_ERRORS = [
  "MISSING_SCOPE",
  "MISSING_CHANNEL",
  "CHANNEL_REJECTED",
  "MISSING_PUBLICATION",
  "SHOPIFY_READ_FAILED",
  "PUBLICATION_CHANGED",
  "INCOMPLETE_EXPORT",
] as const;
export type CatalogImportError = (typeof CATALOG_IMPORT_ERRORS)[number];

export interface CatalogImportStatus {
  phase: "queued" | "processing" | "submitted" | "failed";
  total: number;
  failed: number;
  // Active products published to Aura's channel in the snapshot.
  eligible?: number;
  // Admitted withdrawals of unselected or inactive products. Withdrawing a
  // product that was never imported is a no-op downstream.
  withdrawn?: number;
  error?: CatalogImportError;
  updatedAt: string;
}

export async function saveCatalogImportStatus(
  kv: Pick<KV, "put">,
  shop: string,
  status: Omit<CatalogImportStatus, "updatedAt">,
) {
  const value = JSON.stringify({
    ...status,
    updatedAt: new Date().toISOString(),
  });
  await updateCatalogImportStatus(() =>
    kv.put(STATUS_PREFIX + shop.toLowerCase(), value, {
      expirationTtl: 7 * 24 * 60 * 60,
    }),
  );
}

async function updateCatalogImportStatus(write: () => Promise<void>) {
  // KV permits one write per key per second. A small catalog can finish
  // immediately after its processing status was saved. Retry boundedly, and
  // never let optional progress reporting change the import's actual outcome.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await write();
      return;
    } catch {
      if (attempt < 2)
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  console.warn("Catalog import status could not be updated");
}

export async function loadCatalogImportStatus(
  kv: Pick<KV, "get">,
  shop: string,
) {
  try {
    const raw = await kv.get(STATUS_PREFIX + shop.toLowerCase());
    if (!raw) return null;
    const value = JSON.parse(raw) as CatalogImportStatus;
    const optionalCount = (count: unknown) =>
      count === undefined ||
      (Number.isSafeInteger(count) && (count as number) >= 0);
    if (
      ["queued", "processing", "submitted", "failed"].includes(value.phase) &&
      Number.isSafeInteger(value.total) &&
      value.total >= 0 &&
      Number.isSafeInteger(value.failed) &&
      value.failed >= 0 &&
      value.failed <= value.total &&
      optionalCount(value.eligible) &&
      (value.eligible ?? 0) <= value.total &&
      optionalCount(value.withdrawn) &&
      (value.error === undefined ||
        CATALOG_IMPORT_ERRORS.includes(value.error)) &&
      typeof value.updatedAt === "string" &&
      Number.isFinite(Date.parse(value.updatedAt))
    ) {
      // A terminated background callback cannot write its own failure status.
      const timedOut =
        (value.phase === "processing" &&
          Date.now() - Date.parse(value.updatedAt) > 5 * 60_000) ||
        (value.phase === "queued" &&
          Date.now() - Date.parse(value.updatedAt) > 60 * 60_000);
      return {
        phase: timedOut ? ("failed" as const) : value.phase,
        total: value.total,
        failed: value.failed,
        eligible: value.eligible,
        withdrawn: value.withdrawn,
        error: value.error,
        updatedAt: value.updatedAt,
      };
    }
  } catch {
    /* Invalid or unavailable progress never prevents access to the app. */
  }
  return null;
}

export async function clearCatalogImportStatus(
  kv: Pick<KV, "delete">,
  shop: string,
) {
  // Progress cleanup must not prevent credential/session teardown.
  await updateCatalogImportStatus(() =>
    kv.delete(STATUS_PREFIX + shop.toLowerCase()),
  );
}

export type ChannelPublicationState =
  | "missing_scope"
  | "missing_channel"
  | "missing_publication"
  | "unavailable";

export type ChannelPublicationResolution =
  | { state: "ready"; publicationId: string }
  | { state: ChannelPublicationState };

export const CHANNEL_PUBLICATION_ERRORS: Record<
  ChannelPublicationState,
  CatalogImportError
> = {
  missing_scope: "MISSING_SCOPE",
  missing_channel: "MISSING_CHANNEL",
  missing_publication: "MISSING_PUBLICATION",
  unavailable: "SHOPIFY_READ_FAILED",
};

export const CHANNEL_PROVISIONING_ERRORS: Record<
  Exclude<ChannelProvisioning["state"], "ready">,
  CatalogImportError
> = {
  missing_scope: "MISSING_SCOPE",
  rejected: "CHANNEL_REJECTED",
  unavailable: "SHOPIFY_READ_FAILED",
};

async function readChannelPublication(
  graphql: GraphqlRequestFn,
  listingSourceId: string,
  includeCount: boolean,
): Promise<{
  resolution: ChannelPublicationResolution;
  channel?: AuraChannel;
}> {
  // Listing and publication access are both required: without either, the
  // publication and the products' membership in it cannot be read.
  const access = await readCatalogAccess(graphql);
  if (access !== "granted")
    return {
      resolution: {
        state: access === "missing" ? "missing_scope" : "unavailable",
      },
    };
  const channel = await readAuraChannel(graphql, includeCount);
  if (channel === undefined) return { resolution: { state: "unavailable" } };
  // Only the connection bound to the authorized listing source selects the
  // products imported into it.
  if (!isBoundChannel(channel, listingSourceId))
    return { resolution: { state: "missing_channel" } };
  const publication = await findChannelPublication(graphql, channel.id);
  if (publication.state !== "ready")
    return {
      resolution: {
        state:
          publication.state === "missing"
            ? "missing_publication"
            : "unavailable",
      },
    };
  return {
    resolution: { state: "ready", publicationId: publication.publicationId },
    channel,
  };
}

// Resolves the publication of this installation's channel connection for the
// given listing source. Missing access, a missing or foreign connection and
// failed reads never fall back to another channel.
export async function resolveChannelPublication(
  graphql: GraphqlRequestFn,
  listingSourceId: string,
): Promise<ChannelPublicationResolution> {
  return (await readChannelPublication(graphql, listingSourceId, false))
    .resolution;
}

export type ChannelPublication =
  | {
      state: "ready";
      // Active products published to the channel in Shopify. This is not an
      // import count.
      count: number | null;
      atLeast: boolean;
      editorUrl: string;
    }
  | { state: ChannelPublicationState };

export async function getChannelPublication(
  graphql: GraphqlRequestFn,
  shop: string,
  listingSourceId: string,
): Promise<ChannelPublication> {
  const { resolution, channel } = await readChannelPublication(
    graphql,
    listingSourceId,
    true,
  );
  if (resolution.state !== "ready") return resolution;
  const id = PUBLICATION_GID.exec(resolution.publicationId)?.[1] ?? "";
  const count = channel?.productsCount?.count;
  const precision = channel?.productsCount?.precision;
  const counted =
    Number.isSafeInteger(count) &&
    (count as number) >= 0 &&
    (precision === "EXACT" || precision === "AT_LEAST");
  const editor = new URL(
    `https://admin.shopify.com/store/${encodeURIComponent(getShopifyStoreName(shop))}/bulk`,
  );
  editor.searchParams.set("resource_name", "Product");
  editor.searchParams.set("edit", `publications.${id}.published_at`);
  return {
    state: "ready",
    count: counted ? (count as number) : null,
    atLeast: counted && precision === "AT_LEAST",
    editorUrl: editor.toString(),
  };
}
