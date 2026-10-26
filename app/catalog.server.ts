import type { GraphqlRequestFn } from "./backfill.server";
import { getShopifyStoreName } from "./shopify-admin-url";

type KV = Pick<CloudflareBindings["KV"], "get" | "put" | "delete">;
const STATUS_PREFIX = "aura-historia:catalog-status:";

export interface CatalogImportStatus {
  phase: "queued" | "processing" | "submitted" | "failed";
  total: number;
  failed: number;
  updatedAt: string;
}

export async function saveCatalogImportStatus(
  kv: Pick<KV, "put">,
  shop: string,
  status: Omit<CatalogImportStatus, "updatedAt">,
) {
  await kv.put(
    STATUS_PREFIX + shop.toLowerCase(),
    JSON.stringify({ ...status, updatedAt: new Date().toISOString() }),
    { expirationTtl: 7 * 24 * 60 * 60 },
  );
}

export async function loadCatalogImportStatus(
  kv: Pick<KV, "get">,
  shop: string,
) {
  const raw = await kv.get(STATUS_PREFIX + shop.toLowerCase());
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as CatalogImportStatus;
    if (
      ["queued", "processing", "submitted", "failed"].includes(value.phase) &&
      Number.isSafeInteger(value.total) &&
      value.total >= 0 &&
      Number.isSafeInteger(value.failed) &&
      value.failed >= 0 &&
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
        updatedAt: value.updatedAt,
      };
    }
  } catch {
    /* Invalid state is unavailable, never success. */
  }
  return null;
}

export async function clearCatalogImportStatus(
  kv: Pick<KV, "delete">,
  shop: string,
) {
  await kv.delete(STATUS_PREFIX + shop.toLowerCase());
}

export async function getChannelPublication(
  graphql: GraphqlRequestFn,
  shop: string,
) {
  try {
    const response = await graphql(
      `query AuraChannelPublication {
      currentAppInstallation {
        publication {
          id
          includedProductsCount(query: "status:active") { count precision }
        }
      }
    }`,
      {},
    );
    if (response.errors) return null;
    const data = response.data as
      | {
          currentAppInstallation?: {
            publication?: {
              id?: string;
              includedProductsCount?: { count?: number; precision?: string };
            };
          };
        }
      | undefined;
    const publication = data?.currentAppInstallation?.publication;
    const id = publication?.id?.match(
      /^gid:\/\/shopify\/Publication\/(\d+)$/,
    )?.[1];
    const count = publication?.includedProductsCount?.count;
    const precision = publication?.includedProductsCount?.precision;
    if (
      !id ||
      !Number.isSafeInteger(count) ||
      (count as number) < 0 ||
      !["EXACT", "AT_LEAST"].includes(precision ?? "")
    )
      return null;
    const editor = new URL(
      `https://admin.shopify.com/store/${encodeURIComponent(getShopifyStoreName(shop))}/bulk`,
    );
    editor.searchParams.set("resource_name", "Product");
    editor.searchParams.set("edit", `publications.${id}.published_at`);
    return {
      count: count as number,
      atLeast: precision === "AT_LEAST",
      editorUrl: editor.toString(),
    };
  } catch {
    return null;
  }
}
