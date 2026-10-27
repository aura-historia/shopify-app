import {
  CHANNEL_PUBLICATION_ERRORS,
  PUBLICATION_GID,
  resolveChannelPublication,
  saveCatalogImportStatus,
} from "./catalog.server";
import { CURRENCY_MINOR_UNITS } from "./currency";
import { createClient } from "./generated/api/client";
import {
  deleteAsyncPartnerProductListings,
  listPartnerProductListings,
  putAsyncPartnerProductListings,
  putShopifyListingSourceIngestionConfiguration,
} from "./generated/api/sdk.gen";
import type {
  AdminProductListingPage,
  AsyncProductListingBatchReport,
  CurrencyData,
  LanguageData,
  ListingAvailabilityData,
  PutShopifyListingSourceIngestionConfigurationData,
  UpsertProductListingData,
  WithdrawProductListingData,
} from "./generated/api/types.gen";
import { isValidListingSourceId } from "./shop-credentials.server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;
const BACKFILL_CONTEXT_PREFIX = "aura-historia:backfill:";
const BACKFILL_CONTEXT_TTL_SECONDS = 3600;
// Bounds the absence reconciliation read to 100,000 active source listings.
const MAX_RECONCILIATION_PAGES = 1000;
// Listings changed shortly before the snapshot started may reflect a newer
// listing event than the snapshot; leave them to the next reconciliation.
const RECONCILIATION_CLOCK_MARGIN_MS = 5 * 60_000;
const SHOPIFY_PRODUCT_ID = /^[1-9]\d*$/;

// Proposed batch-level ordering context for aura-historia/backend#2572: the
// Shopify snapshot start time, a lower bound for every observation in the
// batch. It is resent unchanged with each retry under the same idempotency key.
export const SOURCE_OCCURRED_AT_HEADER = "Source-Occurred-At";

// Bulk queries take no variables. The validated publication GID is embedded so
// every product row carries explicit membership in Aura's own channel.
export function buildBulkProductsQuery(publicationId: string): string {
  if (!PUBLICATION_GID.test(publicationId))
    throw new Error("Invalid Shopify publication ID");
  return `
{
  products {
    edges {
      node {
        id
        title
        handle
        status
        totalInventory
        tracksInventory
        onlineStoreUrl
        publishedOnPublication(publicationId: "${publicationId}")
        images {
          edges {
            node {
              id
              url
            }
          }
        }
        variants(first: 1) {
          edges {
            node {
              id
              price
            }
          }
        }
      }
    }
  }
}
`;
}

const SHOP_METADATA_QUERY = `
query {
  shopLocales {
    locale
    primary
  }
  shop {
    currencyCode
  }
}
`;

const SUBMIT_BULK_OPERATION_MUTATION = `
mutation BulkOperationRunQuery($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation {
      id
      status
      createdAt
    }
    userErrors {
      field
      message
    }
  }
}
`;

const BULK_OPERATION_STATUS_QUERY = `
query BulkOperationStatus($id: ID!) {
  node(id: $id) {
    ... on BulkOperation {
      id
      status
      errorCode
      objectCount
      rootObjectCount
      url
    }
  }
}
`;

const SUPPORTED_CURRENCIES = new Set(Object.keys(CURRENCY_MINOR_UNITS));

const SHOPIFY_LOCALE_TO_LANGUAGE: Record<string, LanguageData> = {
  de: "de",
  en: "en",
  fr: "fr",
  es: "es",
  it: "it",
  zh: "zh",
  pt: "pt",
  pl: "pl",
  tr: "tr",
  nl: "nl",
  cs: "cs",
  ja: "ja",
  ru: "ru",
  ar: "ar",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillContext {
  listingSourceId: string;
  accessToken: string;
  apiBaseUrl: string;
  primaryLocale?: string;
  currencyCode: CurrencyData;
  shopDomain: string;

  bulkOperationId: string;
  // The app publication whose membership the snapshot reads.
  publicationId: string;
  // Shopify's creation time of the bulk operation (snapshot lower bound).
  snapshotStartedAt: string;
  createdAt: string;
}

export interface ShopMetadata {
  primaryLocale?: string;
  currencyCode?: string;
}

export interface ValidatedShopifyMetadata {
  primaryLocale?: string;
  currencyCode: CurrencyData;
}

interface GraphqlResponse {
  data?: Record<string, unknown>;
  errors?: unknown;
}

export type GraphqlRequestFn = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<GraphqlResponse>;

export interface ShopifyAdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface BulkJsonlProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  totalInventory: number;
  tracksInventory: boolean;
  onlineStoreUrl: string | null;
  publishedOnPublication?: boolean | null;
}

export interface BulkOperationResult {
  url: string | null;
  rootObjectCount: number | null;
}

export interface BackfillOutcome {
  total: number;
  eligible: number;
  withdrawn: number;
  failures: string[];
  // The export was verified complete and every membership read was explicit.
  complete: boolean;
  // Absence-based withdrawal ran against the complete snapshot.
  reconciled: boolean;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function stringifyGraphqlError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

function collectGraphqlErrorMessages(errors: unknown): string[] {
  if (!errors) {
    return [];
  }

  if (Array.isArray(errors)) {
    return errors
      .flatMap((error) => collectGraphqlErrorMessages(error))
      .filter(Boolean);
  }

  if (typeof errors === "string") {
    return errors ? [errors] : [];
  }

  if (errors && typeof errors === "object") {
    const nestedErrors =
      (errors as { graphQLErrors?: unknown; errors?: unknown }).graphQLErrors ??
      (errors as { errors?: unknown }).errors;

    if (nestedErrors && nestedErrors !== errors) {
      const nestedMessages = collectGraphqlErrorMessages(nestedErrors);
      if (nestedMessages.length > 0) {
        return nestedMessages;
      }
    }
  }

  return [stringifyGraphqlError(errors)];
}

function formatGraphqlErrors(errors: unknown): string | null {
  const messages = collectGraphqlErrorMessages(errors);
  return messages.length > 0 ? messages.join(", ") : null;
}

export function extractShopifyNumericId(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1];
}

export function mapShopifyAvailability(
  tracksInventory: boolean,
  totalInventory: number,
): ListingAvailabilityData | null {
  if (!tracksInventory) return null;
  return totalInventory > 0 ? "IN_STOCK" : "OUT_OF_STOCK";
}

export function mapShopifyLocaleToLanguage(
  shopifyLocale?: string | null,
): LanguageData | undefined {
  if (!shopifyLocale) {
    return undefined;
  }

  const base = shopifyLocale.split("-")[0].toLowerCase();
  return SHOPIFY_LOCALE_TO_LANGUAGE[base];
}

export function resolveLanguage(shopifyLocale?: string): LanguageData {
  return mapShopifyLocaleToLanguage(shopifyLocale) ?? "en";
}

export function mapShopifyCurrencyCode(
  currencyCode?: string | null,
): CurrencyData | undefined {
  const normalizedCurrencyCode = currencyCode as CurrencyData | undefined;

  if (
    !normalizedCurrencyCode ||
    !SUPPORTED_CURRENCIES.has(normalizedCurrencyCode)
  ) {
    return undefined;
  }

  return normalizedCurrencyCode;
}

export function requireSupportedShopifyCurrency(
  currencyCode?: string | null,
): CurrencyData {
  const currency = mapShopifyCurrencyCode(currencyCode);
  if (!currency) {
    throw new Error(
      `Unsupported or missing Shopify currency: ${currencyCode ?? "missing"}`,
    );
  }
  return currency;
}

export function normalizeShopifyDomain(
  shopDomain?: string | null,
): string | undefined {
  const normalizedShopDomain = shopDomain?.trim().toLowerCase();

  if (!normalizedShopDomain) {
    return undefined;
  }

  return normalizedShopDomain;
}

export function buildShopifyIngestionConfiguration(
  metadata: ShopMetadata,
  shopDomain: string,
): PutShopifyListingSourceIngestionConfigurationData {
  const domain = normalizeShopifyDomain(shopDomain);
  if (!domain || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error("Invalid Shopify domain for ingestion configuration");
  }
  return {
    domain,
    currency: requireSupportedShopifyCurrency(metadata.currencyCode),
    ...(mapShopifyLocaleToLanguage(metadata.primaryLocale) && {
      language: mapShopifyLocaleToLanguage(metadata.primaryLocale),
    }),
  };
}

// ---------------------------------------------------------------------------
// Product transformation
// ---------------------------------------------------------------------------

// Shopify returns decimal price strings. Convert via integer arithmetic, never float rounding.
function toMinorUnits(price: string, exponent: number): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent)))
    return null;
  const amount =
    BigInt(match[1]) * 10n ** BigInt(exponent) +
    BigInt((fraction.slice(0, exponent) || "").padEnd(exponent, "0") || "0");
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

export function transformProduct(
  product: BulkJsonlProduct,
  images: string[],
  variantPrice: string | null,
  locale: string | undefined,
  currencyCode: string,
  shopDomain: string,
): UpsertProductListingData {
  const currency = mapShopifyCurrencyCode(currencyCode);
  const amount =
    currency && variantPrice !== null
      ? toMinorUnits(variantPrice, CURRENCY_MINOR_UNITS[currency])
      : null;
  const handle = product.handle?.trim();
  const url =
    product.onlineStoreUrl ??
    (handle
      ? `https://${normalizeShopifyDomain(shopDomain)}/products/${encodeURIComponent(handle)}`
      : null);
  if (!url)
    throw new Error(`Missing storefront URL for Shopify product ${product.id}`);

  return {
    sourceListingId: extractShopifyNumericId(product.id),
    title: { text: product.title, language: resolveLanguage(locale) },
    price:
      currency && amount !== null
        ? { type: "MONETARY", currency, amount }
        : null,
    availability: mapShopifyAvailability(
      product.tracksInventory,
      product.totalInventory,
    ),
    url,
    images,
  };
}

export function transformWithdrawal(
  product: BulkJsonlProduct,
): WithdrawProductListingData {
  return { sourceListingId: extractShopifyNumericId(product.id) };
}

type ShopifyBackfillAction = "upsert" | "withdraw" | "ignore" | "unknown";

export function classifyShopifyBackfillAction(
  product: BulkJsonlProduct,
): ShopifyBackfillAction {
  switch (product.status) {
    case "ACTIVE":
      // Only explicit membership in Aura's own publication admits a listing.
      // A missing or malformed read is unknown, never eligible or ineligible.
      if (product.publishedOnPublication === true) return "upsert";
      if (product.publishedOnPublication === false) return "withdraw";
      return "unknown";
    case "DRAFT":
    case "ARCHIVED":
      return "withdraw";
    case "UNLISTED":
    default:
      return "ignore";
  }
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

export function parseProductsFromJsonl(jsonl: string): {
  products: BulkJsonlProduct[];
  images: Map<string, string[]>;
  variants: Map<string, string | null>;
} {
  const products: BulkJsonlProduct[] = [];
  const images = new Map<string, string[]>();
  const variants = new Map<string, string | null>();
  const lines = jsonl.split("\n").filter((line) => line.trim());

  for (const line of lines) {
    const obj = JSON.parse(line);

    if (!obj.__parentId) {
      products.push(obj as BulkJsonlProduct);
      if (!images.has(obj.id)) {
        images.set(obj.id, []);
      }
    } else if (obj.url && obj.price === undefined) {
      const parentImages = images.get(obj.__parentId) ?? [];
      parentImages.push(obj.url);
      images.set(obj.__parentId, parentImages);
    } else if (obj.price !== undefined) {
      if (!variants.has(obj.__parentId)) {
        variants.set(obj.__parentId, obj.price);
      }
    }
  }

  return { products, images, variants };
}

// ---------------------------------------------------------------------------
// Backfill context KV helpers
// ---------------------------------------------------------------------------

function backfillContextKey(shop: string): string {
  return `${BACKFILL_CONTEXT_PREFIX}${shop.toLowerCase()}`;
}

export async function storeBackfillContext(
  kv: {
    put: (
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) => Promise<void>;
  },
  shop: string,
  context: BackfillContext,
): Promise<void> {
  await kv.put(backfillContextKey(shop), JSON.stringify(context), {
    expirationTtl: BACKFILL_CONTEXT_TTL_SECONDS,
  });
}

export async function loadBackfillContext(
  kv: { get: (key: string) => Promise<string | null> },
  shop: string,
): Promise<BackfillContext | null> {
  const raw = await kv.get(backfillContextKey(shop));
  if (!raw) return null;
  try {
    const context: unknown = JSON.parse(raw);
    if (!context || typeof context !== "object") return null;
    const value = context as Partial<BackfillContext>;
    return typeof value.listingSourceId === "string" &&
      isValidListingSourceId(value.listingSourceId) &&
      typeof value.accessToken === "string" &&
      typeof value.apiBaseUrl === "string" &&
      typeof value.shopDomain === "string" &&
      typeof value.bulkOperationId === "string" &&
      typeof value.publicationId === "string" &&
      PUBLICATION_GID.test(value.publicationId) &&
      typeof value.snapshotStartedAt === "string" &&
      Number.isFinite(Date.parse(value.snapshotStartedAt)) &&
      (value.primaryLocale === undefined ||
        typeof value.primaryLocale === "string") &&
      mapShopifyCurrencyCode(value.currencyCode) &&
      typeof value.createdAt === "string"
      ? (value as BackfillContext)
      : null;
  } catch {
    return null;
  }
}

export async function clearBackfillContext(
  kv: { delete: (key: string) => Promise<void> },
  shop: string,
): Promise<void> {
  await kv.delete(backfillContextKey(shop));
}

// ---------------------------------------------------------------------------
// Shop metadata (locale + currency)
// ---------------------------------------------------------------------------

interface ShopLocale {
  locale: string;
  primary: boolean;
}

interface ShopMetadataResponse {
  data?: {
    shopLocales?: ShopLocale[];
    shop?: { currencyCode: string };
  };
  errors?: unknown;
}

export async function fetchShopMetadata(
  graphqlRequest: GraphqlRequestFn,
): Promise<ShopMetadata> {
  const response = (await graphqlRequest(
    SHOP_METADATA_QUERY,
    {},
  )) as ShopMetadataResponse;

  const errorMessage = formatGraphqlErrors(response.errors);
  if (errorMessage) {
    throw new Error(`Failed to fetch shop metadata: ${errorMessage}`);
  }

  const locales = response.data?.shopLocales ?? [];
  const primary = locales.find((l) => l.primary);
  const primaryLocale = primary?.locale;
  const currencyCode = response.data?.shop?.currencyCode;

  return { primaryLocale, currencyCode };
}

// ---------------------------------------------------------------------------
// Bulk operation submission
// ---------------------------------------------------------------------------

interface BulkOperationSubmitResponse {
  data?: {
    bulkOperationRunQuery?: {
      bulkOperation?: {
        id: string;
        status: string;
        createdAt?: string;
      } | null;
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  };
  errors?: unknown;
}

export async function submitBulkOperation(
  graphqlRequest: GraphqlRequestFn,
  publicationId: string,
): Promise<{ id: string; createdAt: string }> {
  const query = buildBulkProductsQuery(publicationId);
  // Fallback lower bound if Shopify omits its own creation time.
  const requestedAt = new Date().toISOString();
  const response = (await graphqlRequest(SUBMIT_BULK_OPERATION_MUTATION, {
    query,
  })) as BulkOperationSubmitResponse;

  const errorMessage = formatGraphqlErrors(response.errors);
  if (errorMessage) {
    throw new Error(`Bulk operation submission failed: ${errorMessage}`);
  }

  const result = response.data?.bulkOperationRunQuery;
  const userErrors = result?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `Bulk operation user errors: ${userErrors.map((e) => e.message).join(", ")}`,
    );
  }

  const opId = result?.bulkOperation?.id;
  if (!opId) {
    throw new Error("Bulk operation submission returned no operation ID");
  }
  const createdAt = result?.bulkOperation?.createdAt;

  return {
    id: opId,
    createdAt:
      typeof createdAt === "string" && Number.isFinite(Date.parse(createdAt))
        ? new Date(createdAt).toISOString()
        : requestedAt,
  };
}

// ---------------------------------------------------------------------------
// Shopify Admin GraphQL helpers
// ---------------------------------------------------------------------------

export function createAdminGraphqlRequest(
  admin: ShopifyAdminGraphqlClient,
): GraphqlRequestFn {
  return async (query, variables) => {
    const response = await admin.graphql(query, { variables });
    return response.json() as Promise<GraphqlResponse>;
  };
}

// ---------------------------------------------------------------------------
// Bulk operation result fetching (used in webhook handler)
// ---------------------------------------------------------------------------

interface BulkOperationNodeResponse {
  data?: {
    node?: {
      id: string;
      status: string;
      errorCode: string | null;
      objectCount?: string;
      rootObjectCount?: string;
      url: string | null;
    } | null;
  };
  errors?: unknown;
}

function parseCount(value: unknown): number | null {
  const count =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(count) ? count : null;
}

export async function fetchBulkOperationResult(
  graphqlRequest: GraphqlRequestFn,
  bulkOperationId: string,
): Promise<BulkOperationResult> {
  const json = (await graphqlRequest(BULK_OPERATION_STATUS_QUERY, {
    id: bulkOperationId,
  })) as BulkOperationNodeResponse;

  const errorMessage = formatGraphqlErrors(json.errors);
  if (errorMessage) {
    throw new Error(`Failed to query bulk operation: ${errorMessage}`);
  }

  const node = json.data?.node;
  if (node?.status !== "COMPLETED" || node.errorCode)
    throw new Error("Shopify catalog export did not complete");
  if (!node.url && node.objectCount !== "0")
    throw new Error("Shopify catalog export has no download URL");

  return {
    url: node.url ?? null,
    rootObjectCount: parseCount(node.rootObjectCount),
  };
}

// ---------------------------------------------------------------------------
// Sending products to external API
// ---------------------------------------------------------------------------

export function createBackfillIdempotencyKey(
  bulkOperationId: string,
  verb: "put" | "delete" | "reconcile",
  batchIndex: number,
): string {
  const operationId = /^gid:\/\/shopify\/BulkOperation\/(\d+)$/.exec(
    bulkOperationId,
  )?.[1];
  if (!operationId || !Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    throw new Error("Invalid bulk operation ID or batch index");
  }
  const key = `shopify-backfill-${operationId}-${verb}-${batchIndex}`;
  if (key.length > 128)
    throw new Error("Bulk operation ID exceeds idempotency key limit");
  return key;
}

function isBatchReport(
  value: unknown,
): value is AsyncProductListingBatchReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<AsyncProductListingBatchReport>;
  return (
    typeof report.submissionId === "string" &&
    Number.isInteger(report.acceptedCount) &&
    Array.isArray(report.failures) &&
    report.failures.every(
      (failure) =>
        Number.isInteger(failure.index) &&
        typeof failure.retryable === "boolean",
    )
  );
}

function reportFailures(
  report: AsyncProductListingBatchReport,
  items: Array<UpsertProductListingData | WithdrawProductListingData>,
): string[] {
  if (
    report.acceptedCount + report.failures.length !== items.length ||
    report.failures.some(({ index }) => index < 0 || index >= items.length)
  ) {
    throw new Error("Invalid async ProductListing admission report");
  }
  return report.failures.map(({ index }) => items[index].sourceListingId);
}

export async function sendProductBatch(
  items: UpsertProductListingData[] | WithdrawProductListingData[],
  apiBaseUrl: string,
  listingSourceId: string,
  accessToken: string,
  verb: "put" | "delete",
  idempotencyKey: string,
  sourceOccurredAt?: string,
): Promise<string[]> {
  if (items.length > BATCH_SIZE)
    throw new Error("Async batch exceeds 100 items");
  const client = createClient({ baseUrl: apiBaseUrl });
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Idempotency-Key": idempotencyKey,
    ...(sourceOccurredAt && { [SOURCE_OCCURRED_AT_HEADER]: sourceOccurredAt }),
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const result =
      verb === "put"
        ? await putAsyncPartnerProductListings({
            client,
            body: items as UpsertProductListingData[],
            path: { listingSourceId },
            headers,
          })
        : await deleteAsyncPartnerProductListings({
            client,
            body: items as WithdrawProductListingData[],
            path: { listingSourceId },
            headers,
          });
    const report: unknown = result.error ?? result.data;
    if (isBatchReport(report)) {
      if (report.failures.some((failure) => failure.retryable) && attempt < 2)
        continue;
      return reportFailures(report, items);
    }
    // A response-less error may be a timeout after queue admission. Retry only
    // the identical ordered body with the same key; never compact failed entries.
    if ((!result.response || result.response.status === 503) && attempt < 2)
      continue;
    const status = result.response?.status ?? "transport";
    throw new Error(`ProductListing admission failed (${status})`);
  }
  throw new Error("ProductListing admission retry limit reached");
}

export async function configureShopifyListingSource(
  graphqlRequest: GraphqlRequestFn,
  apiBaseUrl: string,
  listingSourceId: string,
  accessToken: string,
  shopDomain: string,
): Promise<ValidatedShopifyMetadata> {
  const metadata = await fetchShopMetadata(graphqlRequest);
  const validatedMetadata: ValidatedShopifyMetadata = {
    primaryLocale: metadata.primaryLocale,
    currencyCode: requireSupportedShopifyCurrency(metadata.currencyCode),
  };
  await putShopifyIngestionConfiguration(
    apiBaseUrl,
    listingSourceId,
    accessToken,
    validatedMetadata,
    shopDomain,
  );
  return validatedMetadata;
}

export async function putShopifyIngestionConfiguration(
  apiBaseUrl: string,
  listingSourceId: string,
  accessToken: string,
  metadata: ShopMetadata,
  shopDomain: string,
): Promise<boolean> {
  const result = await putShopifyListingSourceIngestionConfiguration({
    client: createClient({ baseUrl: apiBaseUrl }),
    body: buildShopifyIngestionConfiguration(metadata, shopDomain),
    path: { listingSourceId },
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (result.response?.status !== 201 && result.response?.status !== 204) {
    throw new Error(
      `Shopify ingestion configuration failed (${result.response?.status ?? "transport"})`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Source-scoped reconciliation of absent listings
// ---------------------------------------------------------------------------

async function listActiveSourceListings(
  context: BackfillContext,
): Promise<AdminProductListingPage["items"]> {
  const client = createClient({ baseUrl: context.apiBaseUrl });
  const listings: AdminProductListingPage["items"] = [];
  let searchAfter: string | undefined;
  for (let page = 0; page < MAX_RECONCILIATION_PAGES; page++) {
    let result: Awaited<ReturnType<typeof listPartnerProductListings>>;
    let attempt = 0;
    do {
      result = await listPartnerProductListings({
        client,
        path: { listingSourceId: context.listingSourceId },
        query: {
          lifecycle: "ACTIVE",
          sort: "created",
          order: "asc",
          size: BATCH_SIZE,
          ...(searchAfter && { searchAfter }),
        },
        headers: { Authorization: `Bearer ${context.accessToken}` },
      });
    } while (
      ++attempt < 3 &&
      (!result.response || result.response.status === 503)
    );
    const data = result.data;
    if (
      result.response?.status !== 200 ||
      !data ||
      !Array.isArray(data.items) ||
      data.items.some(
        (item) =>
          typeof item?.sourceListingId !== "string" ||
          typeof item.updated !== "string",
      )
    )
      throw new Error(
        `ProductListing read failed (${result.response?.status ?? "transport"})`,
      );
    listings.push(...data.items);
    if (!data.searchAfter) return listings;
    searchAfter = data.searchAfter;
  }
  throw new Error("ProductListing reconciliation exceeds its page limit");
}

// Withdraws this source's active Shopify listings that are absent from a
// verified complete snapshot, e.g. products deleted while unselected after
// being imported under the former shop-wide product topics. Products present
// in the snapshot are handled explicitly by their own membership instead.
export async function findAbsentListings(
  context: BackfillContext,
  snapshotIds: ReadonlySet<string>,
): Promise<WithdrawProductListingData[]> {
  const cutoff =
    Date.parse(context.snapshotStartedAt) - RECONCILIATION_CLOCK_MARGIN_MS;
  return (await listActiveSourceListings(context))
    .filter(
      (listing) =>
        listing.lifecycle === "ACTIVE" &&
        // Non-Shopify identities are merchant data, not ours to withdraw.
        SHOPIFY_PRODUCT_ID.test(listing.sourceListingId) &&
        !snapshotIds.has(listing.sourceListingId) &&
        // A listing changed after the snapshot began may be a newer
        // publication; NaN comparisons also keep it.
        Date.parse(listing.updated) < cutoff,
    )
    .map((listing) => ({ sourceListingId: listing.sourceListingId }));
}

// ---------------------------------------------------------------------------
// Process bulk operation results (called from webhook handler)
// ---------------------------------------------------------------------------

export async function processBackfillResults(
  exportResult: BulkOperationResult,
  context: BackfillContext,
): Promise<BackfillOutcome> {
  let jsonl = "";
  if (exportResult.url) {
    const response = await fetch(exportResult.url);
    if (!response.ok) {
      throw new Error(`Failed to download JSONL: ${response.status}`);
    }
    jsonl = await response.text();
  }
  const { products, images, variants } = parseProductsFromJsonl(jsonl);

  // Only an export whose product rows match Shopify's root count is an
  // authoritative selection. A complete empty export is a valid selection.
  let complete = exportResult.rootObjectCount === products.length;
  let eligible = 0;
  const upserts: UpsertProductListingData[] = [];
  const withdrawals: WithdrawProductListingData[] = [];
  const allFailures: string[] = [];
  for (const product of products) {
    const action = classifyShopifyBackfillAction(product);
    if (action === "withdraw") {
      withdrawals.push(transformWithdrawal(product));
    } else if (action === "unknown") {
      complete = false;
      allFailures.push(extractShopifyNumericId(product.id));
      console.error(
        `Unknown Aura channel membership for Shopify product ${product.id}`,
      );
    } else if (action === "upsert") {
      eligible++;
      try {
        upserts.push(
          transformProduct(
            product,
            images.get(product.id) ?? [],
            variants.get(product.id) ?? null,
            context.primaryLocale,
            context.currencyCode,
            context.shopDomain,
          ),
        );
      } catch (error) {
        allFailures.push(extractShopifyNumericId(product.id));
        console.error(
          `Cannot map Shopify product ${product.id} for backfill:`,
          error,
        );
      }
    }
  }

  async function submitBatches(
    items: UpsertProductListingData[] | WithdrawProductListingData[],
    kind: "put" | "delete" | "reconcile",
  ): Promise<number> {
    let failed = 0;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      let failures: string[];
      try {
        failures = await sendProductBatch(
          batch,
          context.apiBaseUrl,
          context.listingSourceId,
          context.accessToken,
          kind === "put" ? "put" : "delete",
          createBackfillIdempotencyKey(
            context.bulkOperationId,
            kind,
            i / BATCH_SIZE,
          ),
          context.snapshotStartedAt,
        );
      } catch (error) {
        failures = batch.map((item) => item.sourceListingId);
        console.error(
          `Backfill ${kind} batch ${i / BATCH_SIZE} failed:`,
          error,
        );
      }
      allFailures.push(...failures);
      failed += failures.length;
    }
    return failed;
  }
  await submitBatches(upserts, "put");
  let withdrawn =
    withdrawals.length - (await submitBatches(withdrawals, "delete"));

  let reconciled = false;
  if (complete) {
    try {
      const absent = await findAbsentListings(
        context,
        new Set(products.map((product) => extractShopifyNumericId(product.id))),
      );
      const failed = await submitBatches(absent, "reconcile");
      withdrawn += absent.length - failed;
      reconciled = failed === 0;
    } catch (error) {
      console.error("Backfill reconciliation could not read listings:", error);
    }
  }
  return {
    total: products.length,
    eligible,
    withdrawn,
    failures: allFailures,
    complete,
    reconciled,
  };
}

// ---------------------------------------------------------------------------
// Trigger backfill (called after OAuth configuration)
// ---------------------------------------------------------------------------

export async function triggerBackfill(
  graphqlRequest: GraphqlRequestFn,
  kv: {
    put: (
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) => Promise<void>;
  },
  shopDomain: string,
  listingSourceId: string,
  accessToken: string,
  apiBaseUrl: string,
  validatedMetadata: ValidatedShopifyMetadata,
): Promise<boolean> {
  try {
    // Missing access, a missing publication or a failed read is a recoverable
    // sync state. It never falls back to importing every active product.
    const publication = await resolveChannelPublication(graphqlRequest);
    if (publication.state !== "ready") {
      await saveCatalogImportStatus(kv, shopDomain, {
        phase: "failed",
        total: 0,
        failed: 0,
        error: CHANNEL_PUBLICATION_ERRORS[publication.state],
      });
      console.warn(
        `Backfill not submitted for ${shopDomain}: publication ${publication.state}`,
      );
      return false;
    }
    const bulkOperation = await submitBulkOperation(
      graphqlRequest,
      publication.publicationId,
    );

    await storeBackfillContext(kv, shopDomain, {
      listingSourceId,
      accessToken,
      apiBaseUrl,
      primaryLocale: validatedMetadata.primaryLocale,
      currencyCode: validatedMetadata.currencyCode,
      shopDomain,
      bulkOperationId: bulkOperation.id,
      publicationId: publication.publicationId,
      snapshotStartedAt: bulkOperation.createdAt,
      createdAt: new Date().toISOString(),
    });

    await saveCatalogImportStatus(kv, shopDomain, {
      phase: "queued",
      total: 0,
      failed: 0,
    });

    console.log(
      `Backfill bulk operation submitted for ${shopDomain}: ${bulkOperation.id}`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Failed to submit backfill for ${shopDomain}:`,
      message
        .replaceAll(accessToken, "[redacted]")
        .replace(/\s+/g, " ")
        .slice(0, 180),
    );
    return false;
  }
}
