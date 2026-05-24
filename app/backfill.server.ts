import { createClient } from "./generated/api/client";
import type { LanguageData, PutProductData } from "./generated/api/types.gen";

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

const SUPPORTED_CURRENCIES = new Set([
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillContext {
  shopId: string;
  apiKey: string;
  apiBaseUrl: string;
  primaryLocale: string;
  currencyCode: string;
  shopDomain: string;
  bulkOperationId: string;
  createdAt: string;
}

export interface ShopMetadata {
  primaryLocale: string;
  currencyCode: string;
}

interface GraphqlResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

export type GraphqlRequestFn = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<GraphqlResponse>;

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

export function resolveLanguage(shopifyLocale: string): LanguageData {
  const base = shopifyLocale.split("-")[0].toLowerCase();
  return SHOPIFY_LOCALE_TO_LANGUAGE[base] ?? "en";
}

export function htmlToMarkdown(html: string): string {
  if (!html) return "";

  let md = html;

  md = md.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi,
    (_m, level, content) => {
      const hashes = "#".repeat(Number(level));
      return `\n\n${hashes} ${cleanInline(content).trim()}\n\n`;
    },
  );

  md = md.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    (_m, content) => {
      const lines = cleanInline(content).trim().split("\n");
      return `\n\n${lines.map((l: string) => `> ${l}`).join("\n")}\n\n`;
    },
  );

  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, content) => {
    let index = 0;
    const items = content.replace(
      /<li[^>]*>([\s\S]*?)<\/li>/gi,
      (_m2: string, item: string) => {
        index++;
        return `${index}. ${cleanInline(item).trim()}\n`;
      },
    );
    return `\n\n${stripAllTags(items).trim()}\n\n`;
  });

  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_m, content) => {
    const items = content.replace(
      /<li[^>]*>([\s\S]*?)<\/li>/gi,
      (_m2: string, item: string) => `- ${cleanInline(item).trim()}\n`,
    );
    return `\n\n${stripAllTags(items).trim()}\n\n`;
  });

  md = md.replace(
    /<p[^>]*>([\s\S]*?)<\/p>/gi,
    (_m, content) => `\n\n${content}\n\n`,
  );
  md = md.replace(/<br\s*\/?>/gi, "\n");
  md = md.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");

  md = cleanInline(md);
  md = stripAllTags(md);
  md = decodeEntities(md);
  md = md.replace(/\n{3,}/g, "\n\n");
  md = md.trim();

  return md;
}

function cleanInline(text: string): string {
  let result = text;
  result = result.replace(
    /<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi,
    "**$2**",
  );
  result = result.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, "*$2*");
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  result = result.replace(
    /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    "[$2]($1)",
  );
  result = result.replace(
    /<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi,
    "![$2]($1)",
  );
  result = result.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");
  return result;
}

function stripAllTags(text: string): string {
  const TAG_RE = /<[^>]*>/g;
  let result = text;
  let prev: string;
  do {
    prev = result;
    result = result.replace(TAG_RE, "");
  } while (result !== prev);
  return result;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
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
      SUPPORTED_CURRENCIES.has(currencyCode)
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
  errors?: Array<{ message: string }>;
}

export async function fetchShopMetadata(
  graphqlRequest: GraphqlRequestFn,
): Promise<ShopMetadata> {
  const response = (await graphqlRequest(
    SHOP_METADATA_QUERY,
    {},
  )) as ShopMetadataResponse;

  if (response.errors?.length) {
    throw new Error(
      `Failed to fetch shop metadata: ${response.errors.map((e) => e.message).join(", ")}`,
    );
  }

  const locales = response.data?.shopLocales ?? [];
  const primary = locales.find((l) => l.primary);
  const primaryLocale = primary?.locale ?? "en";
  const currencyCode = response.data?.shop?.currencyCode ?? "EUR";

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
  errors?: Array<{ message: string }>;
}

export async function submitBulkOperation(
  graphqlRequest: GraphqlRequestFn,
): Promise<string> {
  const response = (await graphqlRequest(SUBMIT_BULK_OPERATION_MUTATION, {
    query: BULK_PRODUCTS_QUERY,
  })) as BulkOperationSubmitResponse;

  if (response.errors?.length) {
    throw new Error(
      `Bulk operation submission failed: ${response.errors.map((e) => e.message).join(", ")}`,
    );
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
  errors?: Array<{ message: string }>;
}

export async function fetchBulkOperationResultUrl(
  shop: string,
  accessToken: string,
  apiVersion: string,
  bulkOperationId: string,
): Promise<string | null> {
  const response = await fetch(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: BULK_OPERATION_STATUS_QUERY,
        variables: { id: bulkOperationId },
      }),
    },
  );

  const json = (await response.json()) as BulkOperationNodeResponse;

  if (json.errors?.length) {
    throw new Error(
      `Failed to query bulk operation: ${json.errors.map((e) => e.message).join(", ")}`,
    );
  }

  const node = json.data?.node;
  if (!node || node.status !== "COMPLETED") {
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
  apiKey: string,
): Promise<string[]> {
  const client = createClient({ baseUrl: apiBaseUrl });
  const { putPartnerProducts } = await import("./generated/api/sdk.gen");

  const result = await putPartnerProducts({
    client,
    body: products,
    path: { shopId },
    headers: {
      "x-api-key": apiKey,
    },
  });

  if (result.error) {
    const status = result.response?.status ?? "unknown";
    throw new Error(`API error ${status}: ${JSON.stringify(result.error)}`);
  }

  return (result.data as string[]) ?? [];
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

  for (let i = 0; i < transformed.length; i += BATCH_SIZE) {
    const batch = transformed.slice(i, i + BATCH_SIZE);
    try {
      const failures = await sendProductBatch(
        batch,
        context.apiBaseUrl,
        context.shopId,
        context.apiKey,
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
// Trigger backfill (called from credentials save action)
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
  apiKey: string,
  apiBaseUrl: string,
): Promise<void> {
  try {
    const metadata = await fetchShopMetadata(graphqlRequest);
    const bulkOperationId = await submitBulkOperation(graphqlRequest);

    await storeBackfillContext(kv, shopDomain, {
      shopId,
      apiKey,
      apiBaseUrl,
      primaryLocale: metadata.primaryLocale,
      currencyCode: metadata.currencyCode,
      shopDomain,
      bulkOperationId,
      createdAt: new Date().toISOString(),
    });

    console.log(
      `Backfill bulk operation submitted for ${shopDomain}: ${bulkOperationId}`,
    );
  } catch (error) {
    console.error(`Failed to submit backfill for ${shopDomain}:`, error);
  }
}
