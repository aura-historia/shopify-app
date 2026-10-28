import {
  type CatalogImportStatus,
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
// Bounds the existing-listing enumeration to one million listings.
const MAX_LISTING_PAGES = 10_000;

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

// Deterministic for one immutable export, so a resumed import replays the
// same upsert batches under the same idempotency keys.
export interface BackfillPlan {
  total: number;
  eligible: number;
  // The export was verified complete and every membership read was explicit.
  complete: boolean;
  // Products with unknown membership or unmappable data; never submitted.
  rejected: string[];
  upserts: UpsertProductListingData[];
  // Products whose existing listings stay: the eligible selection and
  // statuses that imports leave untouched.
  retained: Set<string>;
}

// Durable progress of one catalog import. It holds no credentials.
export interface CatalogImportJob {
  shop: string;
  bulkOperationId: string;
  result?: BulkOperationResult;
  // Existing-listing enumeration: next cursor and pages retained so far.
  listingCursor?: string;
  listingPages: number;
  // Set once the withdrawals of absent listings are retained as batches.
  withdrawals?: number;
  // This source's existing listings could not be read.
  enumerationFailed?: boolean;
  // Index of the next batch: upserts first, then withdrawals.
  cursor: number;
  failed: number;
  withdrawn: number;
  attempts: number;
}

// Durable storage for the existing-listing enumeration and the ordered
// withdrawal batches. Both come from a live read and are never recomputed
// under the same idempotency keys.
export interface CatalogImportStore {
  saveJob(job: CatalogImportJob): Promise<void>;
  putIds(key: string, ids: string[]): Promise<void>;
  getIds(key: string): Promise<string[]>;
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
      bulkOperation?: { id: string; status: string } | null;
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  };
  errors?: unknown;
}

export async function submitBulkOperation(
  graphqlRequest: GraphqlRequestFn,
  publicationId: string,
): Promise<string> {
  const query = buildBulkProductsQuery(publicationId);
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

  return opId;
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
  verb: "put" | "delete",
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
): Promise<string[]> {
  if (items.length > BATCH_SIZE)
    throw new Error("Async batch exceeds 100 items");
  const client = createClient({ baseUrl: apiBaseUrl });
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Idempotency-Key": idempotencyKey,
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
// Process bulk operation results (resumable catalog import steps)
// ---------------------------------------------------------------------------

export async function downloadBackfillExport(
  result: BulkOperationResult,
): Promise<string> {
  if (!result.url) return "";
  const response = await fetch(result.url);
  if (!response.ok) {
    throw new Error(`Failed to download JSONL: ${response.status}`);
  }
  return response.text();
}

export function planBackfill(
  jsonl: string,
  rootObjectCount: number | null,
  context: BackfillContext,
): BackfillPlan {
  const { products, images, variants } = parseProductsFromJsonl(jsonl);
  // Only an export whose product rows match Shopify's root count is an
  // authoritative selection. A complete empty export is a valid selection.
  let complete = rootObjectCount === products.length;
  let eligible = 0;
  const upserts: UpsertProductListingData[] = [];
  const retained = new Set<string>();
  const rejected: string[] = [];
  for (const product of products) {
    const id = extractShopifyNumericId(product.id);
    const action = classifyShopifyBackfillAction(product);
    if (action === "unknown") {
      complete = false;
      rejected.push(id);
    } else if (action === "ignore") {
      retained.add(id);
    } else if (action === "upsert") {
      eligible++;
      retained.add(id);
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
      } catch {
        rejected.push(id);
      }
    }
  }
  return {
    total: products.length,
    eligible,
    complete,
    rejected,
    upserts,
    retained,
  };
}

class ListingReadError extends Error {}

async function readExistingListingPage(
  context: BackfillContext,
  searchAfter: string | undefined,
): Promise<{ ids: string[]; next?: string }> {
  const client = createClient({ baseUrl: context.apiBaseUrl });
  let status: number | string = "transport";
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await listPartnerProductListings({
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
    const items = result.data?.items;
    if (
      result.response?.status === 200 &&
      Array.isArray(items) &&
      items.every((item) => typeof item?.sourceListingId === "string")
    ) {
      return {
        ids: items
          .filter((item) => item.lifecycle === "ACTIVE")
          .map((item) => item.sourceListingId),
        next: result.data?.searchAfter,
      };
    }
    status = result.response?.status ?? "transport";
    if (result.response && result.response.status !== 503) break;
  }
  throw new ListingReadError(`ProductListing read failed (${status})`);
}

// Reads this source's existing listings within the deadline and, once the
// enumeration is complete, retains the withdrawals of listings absent from
// the selection as ordered batches. Returns false while pages remain.
async function retainAbsentListingWithdrawals(
  job: CatalogImportJob,
  context: BackfillContext,
  plan: BackfillPlan,
  deadline: number,
  store: CatalogImportStore,
): Promise<boolean> {
  while (job.listingPages === 0 || job.listingCursor) {
    if (job.listingPages >= MAX_LISTING_PAGES)
      throw new ListingReadError("ProductListing enumeration limit reached");
    if (Date.now() >= deadline) return false;
    const page = await readExistingListingPage(context, job.listingCursor);
    await store.putIds(`existing:${job.listingPages}`, page.ids);
    job.listingPages++;
    job.listingCursor = page.next;
    await store.saveJob(job);
  }
  const absent = new Set<string>();
  for (let page = 0; page < job.listingPages; page++) {
    for (const id of await store.getIds(`existing:${page}`))
      if (!plan.retained.has(id)) absent.add(id);
  }
  const ids = [...absent];
  for (let i = 0; i < ids.length; i += BATCH_SIZE)
    await store.putIds(
      `withdraw:${i / BATCH_SIZE}`,
      ids.slice(i, i + BATCH_SIZE),
    );
  job.withdrawals = ids.length;
  await store.saveJob(job);
  return true;
}

async function submitBackfillBatch(
  verb: "put" | "delete",
  index: number,
  items: UpsertProductListingData[] | WithdrawProductListingData[],
  context: BackfillContext,
): Promise<string[]> {
  try {
    return await sendProductBatch(
      items,
      context.apiBaseUrl,
      context.listingSourceId,
      context.accessToken,
      verb,
      createBackfillIdempotencyKey(context.bulkOperationId, verb, index),
    );
  } catch (error) {
    console.error(
      `Backfill ${verb} batch ${index} failed:`,
      error instanceof Error ? error.message : "unknown error",
    );
    return items.map((item) => item.sourceListingId);
  }
}

// Runs one bounded step of an import. Progress is saved after every page and
// batch, so an interrupted step resumes where it stopped and a replayed batch
// reuses its idempotency key and content. Throws on Shopify read errors.
//
// Selected products are upserted. Withdrawals are submitted only for a
// verified complete selection: this source's existing listings that are
// absent from it are withdrawn, so a valid empty selection withdraws all of
// them. Bulk writes are not ordered against concurrent listing webhooks; a
// fresh complete import repairs any overlap.
export async function runCatalogImportStep(
  job: CatalogImportJob,
  context: BackfillContext,
  graphqlRequest: GraphqlRequestFn,
  deadline: number,
  store: CatalogImportStore,
): Promise<{ done: boolean; status: Omit<CatalogImportStatus, "updatedAt"> }> {
  const result =
    job.result ??
    (await fetchBulkOperationResult(graphqlRequest, job.bulkOperationId));
  // Every step writes with the current installation's access and publication.
  // A revoked scope or replaced channel invalidates the whole snapshot.
  const publication = await resolveChannelPublication(graphqlRequest);
  if (
    publication.state !== "ready" ||
    publication.publicationId !== context.publicationId
  ) {
    return {
      done: true,
      status: {
        phase: "failed",
        total: 0,
        failed: 0,
        error:
          publication.state === "ready"
            ? "PUBLICATION_CHANGED"
            : CHANNEL_PUBLICATION_ERRORS[publication.state],
      },
    };
  }
  if (!job.result) {
    job.result = result;
    await store.saveJob(job);
  }

  const plan = planBackfill(
    await downloadBackfillExport(result),
    result.rootObjectCount,
    context,
  );
  if (job.cursor === 0 && job.listingPages === 0 && plan.rejected.length > 0) {
    console.error(
      `Backfill cannot classify or map ${plan.rejected.length} Shopify products: ${plan.rejected.slice(0, 50).join(", ")}`,
    );
  }
  const counts = () => ({
    total: plan.total,
    eligible: plan.eligible,
    withdrawn: job.withdrawn,
    failed: job.failed + plan.rejected.length,
  });

  if (
    plan.complete &&
    job.withdrawals === undefined &&
    !job.enumerationFailed
  ) {
    try {
      if (
        !(await retainAbsentListingWithdrawals(
          job,
          context,
          plan,
          deadline,
          store,
        ))
      )
        return { done: false, status: { phase: "processing", ...counts() } };
    } catch (error) {
      if (!(error instanceof ListingReadError)) throw error;
      // Without the complete existing-ID enumeration nothing is withdrawn.
      console.error("Backfill cannot read existing listings:", error.message);
      job.enumerationFailed = true;
      await store.saveJob(job);
    }
  }

  const upsertBatches = Math.ceil(plan.upserts.length / BATCH_SIZE);
  const batches =
    upsertBatches + Math.ceil((job.withdrawals ?? 0) / BATCH_SIZE);
  while (job.cursor < batches && Date.now() < deadline) {
    if (job.cursor < upsertBatches) {
      const index = job.cursor;
      const items = plan.upserts.slice(
        index * BATCH_SIZE,
        (index + 1) * BATCH_SIZE,
      );
      job.failed += (
        await submitBackfillBatch("put", index, items, context)
      ).length;
    } else {
      const index = job.cursor - upsertBatches;
      const items = (await store.getIds(`withdraw:${index}`)).map(
        (sourceListingId) => ({ sourceListingId }),
      );
      const failures = await submitBackfillBatch(
        "delete",
        index,
        items,
        context,
      );
      job.failed += failures.length;
      job.withdrawn += items.length - failures.length;
    }
    job.cursor++;
    await store.saveJob(job);
  }

  if (job.cursor < batches)
    return { done: false, status: { phase: "processing", ...counts() } };
  // Unknown membership, a truncated export or an unread enumeration is never
  // reported as a complete reconciliation.
  const error = !plan.complete
    ? "INCOMPLETE_EXPORT"
    : job.enumerationFailed
      ? "RECONCILIATION_FAILED"
      : undefined;
  const status = counts();
  return {
    done: true,
    status:
      error || status.failed
        ? { phase: "failed", ...status, ...(error && { error }) }
        : { phase: "submitted", ...status },
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
    const bulkOperationId = await submitBulkOperation(
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
      bulkOperationId,
      publicationId: publication.publicationId,
      createdAt: new Date().toISOString(),
    });

    await saveCatalogImportStatus(kv, shopDomain, {
      phase: "queued",
      total: 0,
      failed: 0,
    });

    console.log(
      `Backfill bulk operation submitted for ${shopDomain}: ${bulkOperationId}`,
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
