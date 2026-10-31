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

export const CATALOG_IMPORT_ERRORS = [
  "MISSING_SCOPE",
  "MISSING_CHANNEL",
  "CHANNEL_REJECTED",
  "MISSING_PUBLICATION",
  "SHOPIFY_READ_FAILED",
  "PUBLICATION_CHANGED",
  "INCOMPLETE_EXPORT",
  "EXPORT_TOO_LARGE",
  "EXPORT_EXPIRED",
  "IMPORT_EXPIRED",
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
  // A queued import waits for Shopify to return the channel's publication
  // before it exports.
  awaiting?: "CHANNEL_PUBLICATION";
  updatedAt: string;
}

// The catalog importer keeps the progress of its current import generation.
// Only public phase/count fields leave it, and stale progress is reported as
// failed.
export function readCatalogImportStatus(
  value: unknown,
): CatalogImportStatus | null {
  if (!value || typeof value !== "object") return null;
  const status = value as CatalogImportStatus;
  const optionalCount = (count: unknown) =>
    count === undefined ||
    (Number.isSafeInteger(count) && (count as number) >= 0);
  if (
    !["queued", "processing", "submitted", "failed"].includes(status.phase) ||
    !Number.isSafeInteger(status.total) ||
    status.total < 0 ||
    !Number.isSafeInteger(status.failed) ||
    status.failed < 0 ||
    status.failed > status.total ||
    !optionalCount(status.eligible) ||
    (status.eligible ?? 0) > status.total ||
    !optionalCount(status.withdrawn) ||
    (status.error !== undefined &&
      !CATALOG_IMPORT_ERRORS.includes(status.error)) ||
    (status.awaiting !== undefined &&
      status.awaiting !== "CHANNEL_PUBLICATION") ||
    typeof status.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(status.updatedAt))
  )
    return null;
  // A terminated import step cannot write its own failure status.
  const timedOut =
    (status.phase === "processing" &&
      Date.now() - Date.parse(status.updatedAt) > 5 * 60_000) ||
    (status.phase === "queued" &&
      Date.now() - Date.parse(status.updatedAt) > 60 * 60_000);
  return {
    phase: timedOut ? "failed" : status.phase,
    total: status.total,
    failed: status.failed,
    eligible: status.eligible,
    withdrawn: status.withdrawn,
    error: status.error,
    ...(status.awaiting && status.phase === "queued" && !timedOut
      ? { awaiting: status.awaiting }
      : {}),
    updatedAt: status.updatedAt,
  };
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

// Shopify may return the app catalog of a new channel connection, or its
// publication, only some time after `channelCreate`. Until it does, the
// catalog scan finds no catalog listing the connection, or that catalog has
// no publication: the publication is missing. An import that finds it
// missing waits within a bounded window instead of failing. Missing access,
// a missing or foreign connection and failed, denied or ambiguous reads
// never start a wait; they are reported at once.
export function awaitsChannelPublication(
  state: ChannelPublicationState,
): boolean {
  return state === "missing_publication";
}

// While an import waits, a failed read is retried within the same window
// rather than ending the wait; what Shopify last returned is reported when
// the window closes.
export function keepsAwaitingChannelPublication(
  state: ChannelPublicationState,
): boolean {
  return state === "missing_publication" || state === "unavailable";
}

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
