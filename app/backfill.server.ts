import TurndownService from "turndown";
import { createClient } from "./generated/api/client";
import type {
  CurrencyData,
  LanguageData,
  PatchShopData,
  PutProductData,
} from "./generated/api/types.gen";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;
const BACKFILL_CONTEXT_PREFIX = "aura-historia:backfill:";
const BACKFILL_CONTEXT_TTL_SECONDS = 3600;

const BULK_PRODUCTS_QUERY = `
{
  products {
    edges {
      node {
        id
        title
        descriptionHtml
        status
        totalInventory
        onlineStoreUrl
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
      url
    }
  }
}
`;

const SUPPORTED_CURRENCIES = new Set<CurrencyData>([
  "EUR",
  "GBP",
  "USD",
  "AUD",
  "CAD",
  "NZD",
  "CNY",
  "BRL",
  "PLN",
  "TRY",
  "JPY",
  "CZK",
  "RUB",
  "AED",
  "SAR",
  "HKD",
  "SGD",
  "CHF",
]);

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

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillContext {
  shopId: string;
  accessToken?: string;
  /** Legacy field kept so in-flight pre-OAuth backfill contexts can still finish. */
  apiKey?: string;
  apiBaseUrl: string;
  primaryLocale: string;
  currencyCode: string;
  shopDomain: string;
  /** Legacy field from early OAuth backfill contexts; new jobs load the offline session. */
  shopifyAccessToken?: string;
  bulkOperationId: string;
  createdAt: string;
}

export interface ShopMetadata {
  primaryLocale?: string;
  currencyCode?: string;
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
  descriptionHtml: string;
  status: string;
  totalInventory: number | null;
  onlineStoreUrl: string | null;
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

export function mapShopifyStatus(
  status: string,
  totalInventory: number | null,
): PutProductData["state"] & string {
  switch (status) {
    case "ACTIVE":
      if (totalInventory !== null && totalInventory <= 0) {
        return "SOLD";
      }
      return "AVAILABLE";
    case "DRAFT":
      return "LISTED";
    case "ARCHIVED":
      return "REMOVED";
    default:
      return "UNKNOWN";
  }
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

export function resolveLanguage(shopifyLocale: string): LanguageData {
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

export function normalizeShopifyDomain(
  shopDomain?: string | null,
): string | undefined {
  const normalizedShopDomain = shopDomain?.trim().toLowerCase();

  if (!normalizedShopDomain) {
    return undefined;
  }

  return normalizedShopDomain;
}

export function buildShopMetadataPatch(
  metadata: ShopMetadata,
  shopDomain?: string | null,
): PatchShopData | null {
  const patch: PatchShopData = {};
  const shopifyLanguage = mapShopifyLocaleToLanguage(metadata.primaryLocale);
  const shopifyCurrency = mapShopifyCurrencyCode(metadata.currencyCode);
  const shopifyDomain = normalizeShopifyDomain(shopDomain);

  if (shopifyDomain) {
    patch.shopifyDomain = shopifyDomain;
  }

  if (shopifyLanguage) {
    patch.shopifyLanguage = shopifyLanguage;
  }

  if (shopifyCurrency) {
    patch.shopifyCurrency = shopifyCurrency;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

export function htmlToMarkdown(html: string): string {
  if (!html) {
    return "";
  }

  return turndown
    .turndown(html)
    .replace(/\u00a0/g, " ")
    .replace(/^([*-])\s+/gm, "$1 ")
    .replace(/^(\d+)\.\s+/gm, "$1. ")
    .trim();
}

// ---------------------------------------------------------------------------
// Product transformation
// ---------------------------------------------------------------------------

export function transformProduct(
  product: BulkJsonlProduct,
  images: string[],
  variantPrice: string | null,
  locale: string,
  currencyCode: string,
  shopDomain: string,
): PutProductData {
  const shopsProductId = extractShopifyNumericId(product.id);
  const language = resolveLanguage(locale);

  const result: PutProductData = {
    shopsProductId,
    title: { text: product.title, language },
    description: {
      text: htmlToMarkdown(product.descriptionHtml),
      language,
    },
    state: mapShopifyStatus(product.status, product.totalInventory),
    url:
      product.onlineStoreUrl ??
      `https://${shopDomain}/products/${shopsProductId}`,
    images,
  };

  if (variantPrice) {
    const amount = Math.round(Number.parseFloat(variantPrice) * 100);
    if (
      !Number.isNaN(amount) &&
      amount >= 0 &&
      SUPPORTED_CURRENCIES.has(currencyCode as CurrencyData)
    ) {
      result.price = {
        amount,
        currency: currencyCode as PutProductData["price"] &
          object &
          { currency: string }["currency"],
      };
    }
  }

  return result;
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
    return JSON.parse(raw) as BackfillContext;
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
): Promise<string> {
  const response = (await graphqlRequest(SUBMIT_BULK_OPERATION_MUTATION, {
    query: BULK_PRODUCTS_QUERY,
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
      url: string | null;
    } | null;
  };
  errors?: unknown;
}

export async function fetchBulkOperationResultUrl(
  graphqlRequest: GraphqlRequestFn,
  bulkOperationId: string,
): Promise<string | null> {
  const json = (await graphqlRequest(BULK_OPERATION_STATUS_QUERY, {
    id: bulkOperationId,
  })) as BulkOperationNodeResponse;

  const errorMessage = formatGraphqlErrors(json.errors);
  if (errorMessage) {
    throw new Error(`Failed to query bulk operation: ${errorMessage}`);
  }

  const node = json.data?.node;
  if (node?.status !== "COMPLETED") {
    return null;
  }

  return node.url ?? null;
}

// ---------------------------------------------------------------------------
// Sending products to external API
// ---------------------------------------------------------------------------

async function sendProductBatch(
  products: PutProductData[],
  apiBaseUrl: string,
  shopId: string,
  accessToken: string,
): Promise<string[]> {
  const client = createClient({ baseUrl: apiBaseUrl });
  const { putPartnerProducts } = await import("./generated/api/sdk.gen");

  const result = await putPartnerProducts({
    client,
    body: products,
    path: { shopId },
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (result.error) {
    const status = result.response?.status ?? "unknown";
    throw new Error(`API error ${status}: ${JSON.stringify(result.error)}`);
  }

  return (result.data as string[]) ?? [];
}

export async function patchShopMetadata(
  apiBaseUrl: string,
  shopId: string,
  accessToken: string,
  metadata: ShopMetadata,
  shopDomain?: string,
): Promise<boolean> {
  const body = buildShopMetadataPatch(metadata, shopDomain);

  if (!body) {
    return false;
  }

  const client = createClient({ baseUrl: apiBaseUrl });
  const { patchShopById } = await import("./generated/api/sdk.gen");
  const result = await patchShopById({
    client,
    body,
    path: { shopId },
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (result.error) {
    const status = result.response?.status ?? "unknown";
    throw new Error(`API error ${status}: ${JSON.stringify(result.error)}`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Process bulk operation results (called from webhook handler)
// ---------------------------------------------------------------------------

export async function processBackfillResults(
  jsonlUrl: string,
  context: BackfillContext,
): Promise<{ total: number; failures: string[] }> {
  const response = await fetch(jsonlUrl);
  if (!response.ok) {
    throw new Error(`Failed to download JSONL: ${response.status}`);
  }

  const jsonl = await response.text();
  const { products, images, variants } = parseProductsFromJsonl(jsonl);

  if (products.length === 0) {
    return { total: 0, failures: [] };
  }

  const transformed: PutProductData[] = products.map((product) =>
    transformProduct(
      product,
      images.get(product.id) ?? [],
      variants.get(product.id) ?? null,
      context.primaryLocale,
      context.currencyCode,
      context.shopDomain,
    ),
  );

  const allFailures: string[] = [];
  const accessToken = context.accessToken ?? context.apiKey;

  if (!accessToken) {
    throw new Error("Missing Aura Historia access token for backfill context");
  }

  for (let i = 0; i < transformed.length; i += BATCH_SIZE) {
    const batch = transformed.slice(i, i + BATCH_SIZE);
    try {
      const failures = await sendProductBatch(
        batch,
        context.apiBaseUrl,
        context.shopId,
        accessToken,
      );
      allFailures.push(...failures);
    } catch (error) {
      const ids = batch.map((p) => p.shopsProductId);
      allFailures.push(...ids);
      console.error(
        `Backfill batch [${i}..${i + batch.length - 1}] failed:`,
        error,
      );
    }
  }

  return { total: transformed.length, failures: allFailures };
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
  shopId: string,
  accessToken: string,
  apiBaseUrl: string,
): Promise<void> {
  let patchMetadataPromise: Promise<void> | undefined;

  try {
    const metadata = await fetchShopMetadata(graphqlRequest);
    patchMetadataPromise = patchShopMetadata(
      apiBaseUrl,
      shopId,
      accessToken,
      metadata,
      shopDomain,
    )
      .then((patched) => {
        if (patched) {
          console.log(`Shop metadata patched for ${shopDomain}`);
        }
      })
      .catch((error) => {
        console.error(
          `Failed to patch shop metadata for ${shopDomain}:`,
          error,
        );
      });

    const bulkOperationId = await submitBulkOperation(graphqlRequest);

    await storeBackfillContext(kv, shopDomain, {
      shopId,
      accessToken,
      apiBaseUrl,
      primaryLocale: metadata.primaryLocale ?? "en",
      currencyCode: metadata.currencyCode ?? "EUR",
      shopDomain,
      bulkOperationId,
      createdAt: new Date().toISOString(),
    });

    console.log(
      `Backfill bulk operation submitted for ${shopDomain}: ${bulkOperationId}`,
    );
  } catch (error) {
    console.error(`Failed to submit backfill for ${shopDomain}:`, error);
  } finally {
    await patchMetadataPromise;
  }
}
