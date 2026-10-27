import type { GraphqlRequestFn } from "./backfill.server";
import { getShopifyStoreName } from "./shopify-admin-url";

type KV = Pick<CloudflareBindings["KV"], "get" | "put" | "delete">;
const STATUS_PREFIX = "aura-historia:catalog-status:";

// Shopify scope for the app's own channel listings: the listing webhooks and
// per-publication membership reads depend on it.
export const PRODUCT_LISTINGS_SCOPE = "read_product_listings";
export const PUBLICATION_GID = /^gid:\/\/shopify\/Publication\/([1-9]\d*)$/;

export const CATALOG_IMPORT_ERRORS = [
  "MISSING_SCOPE",
  "MISSING_PUBLICATION",
  "SHOPIFY_READ_FAILED",
  "PUBLICATION_CHANGED",
  "INCOMPLETE_EXPORT",
  "RECONCILIATION_FAILED",
] as const;
export type CatalogImportError = (typeof CATALOG_IMPORT_ERRORS)[number];

export interface CatalogImportStatus {
  phase: "queued" | "processing" | "submitted" | "failed";
  total: number;
  failed: number;
  // Active products published to Aura's channel in the snapshot.
  eligible?: number;
  // Admitted withdrawals: unpublished/inactive products and absent records.
  withdrawn?: number;
  // Absence-based cleanup ran against a verified complete snapshot.
  reconciled?: boolean;
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
      optionalCount(value.eligible) &&
      (value.eligible ?? 0) <= value.total &&
      optionalCount(value.withdrawn) &&
      (value.reconciled === undefined ||
        typeof value.reconciled === "boolean") &&
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
        reconciled: value.reconciled,
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
  missing_publication: "MISSING_PUBLICATION",
  unavailable: "SHOPIFY_READ_FAILED",
};

interface ChannelPublicationData {
  currentAppInstallation?: {
    accessScopes?: Array<{ handle?: unknown }>;
    publication?: {
      id?: unknown;
      includedProductsCount?: { count?: unknown; precision?: unknown };
    } | null;
  };
}

async function readChannelPublication(
  graphql: GraphqlRequestFn,
  includeCount: boolean,
): Promise<{
  resolution: ChannelPublicationResolution;
  publication?: NonNullable<
    NonNullable<ChannelPublicationData["currentAppInstallation"]>["publication"]
  >;
}> {
  try {
    // `currentAppInstallation.publication` is deprecated without a successor
    // in 2026-10, but it is the only reference to this app's own channel.
    const response = await graphql(
      `query AuraChannelPublication {
      currentAppInstallation {
        accessScopes { handle }
        publication {
          id
          ${includeCount ? 'includedProductsCount(query: "status:active") { count precision }' : ""}
        }
      }
    }`,
      {},
    );
    const installation = (response.data as ChannelPublicationData | undefined)
      ?.currentAppInstallation;
    const scopes = installation?.accessScopes;
    // Verify the access actually granted to this installation: a changed
    // configuration is not proof that the merchant approved the new scope.
    if (
      Array.isArray(scopes) &&
      !scopes.some((scope) => scope?.handle === PRODUCT_LISTINGS_SCOPE)
    )
      return { resolution: { state: "missing_scope" } };
    if (response.errors || !Array.isArray(scopes))
      return { resolution: { state: "unavailable" } };
    const publication = installation?.publication;
    if (publication === null)
      return { resolution: { state: "missing_publication" } };
    if (
      typeof publication?.id !== "string" ||
      !PUBLICATION_GID.test(publication.id)
    )
      return { resolution: { state: "unavailable" } };
    return {
      resolution: { state: "ready", publicationId: publication.id },
      publication,
    };
  } catch {
    return { resolution: { state: "unavailable" } };
  }
}

// Resolves the current installation's own channel publication. Missing access,
// a missing publication or a failed read never fall back to another channel.
export async function resolveChannelPublication(
  graphql: GraphqlRequestFn,
): Promise<ChannelPublicationResolution> {
  return (await readChannelPublication(graphql, false)).resolution;
}

export type ChannelPublication =
  | {
      state: "ready";
      // Products selected for the channel in Shopify. Included products may
      // still be scheduled for later publication; this is not an import count.
      count: number | null;
      atLeast: boolean;
      editorUrl: string;
    }
  | { state: ChannelPublicationState };

export async function getChannelPublication(
  graphql: GraphqlRequestFn,
  shop: string,
): Promise<ChannelPublication> {
  const { resolution, publication } = await readChannelPublication(
    graphql,
    true,
  );
  if (resolution.state !== "ready") return resolution;
  const id = PUBLICATION_GID.exec(resolution.publicationId)?.[1] ?? "";
  const count = publication?.includedProductsCount?.count;
  const precision = publication?.includedProductsCount?.precision;
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
