import { createClient } from "./generated/api/client";
import type {
  LocalizedTextData,
  PutProductData,
} from "./generated/api/types.gen";

const PRODUCTS_QUERY = `
  query FetchProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          descriptionHtml
          status
          onlineStoreUrl
          images(first: 10) {
            edges {
              node {
                url
              }
            }
          }
          variants(first: 1) {
            edges {
              node {
                price
                currencyCode: presentmentPrices(first: 1) {
                  edges {
                    node {
                      price {
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface ShopifyImage {
  node: { url: string };
}

interface ShopifyPresentmentPrice {
  node: { price: { currencyCode: string } };
}

interface ShopifyVariant {
  node: {
    price: string;
    currencyCode: { edges: ShopifyPresentmentPrice[] };
  };
}

interface ShopifyProduct {
  node: {
    id: string;
    title: string;
    descriptionHtml: string;
    status: string;
    onlineStoreUrl: string | null;
    images: { edges: ShopifyImage[] };
    variants: { edges: ShopifyVariant[] };
  };
}

interface ShopifyProductsResponse {
  data?: {
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: ShopifyProduct[];
    };
  };
  errors?: Array<{ message: string }>;
}

export interface BackfillDependencies {
  graphqlRequest: (
    query: string,
    variables: Record<string, unknown>,
  ) => Promise<ShopifyProductsResponse>;
  apiBaseUrl: string;
  shopId: string;
  apiKey: string;
  shopDomain: string;
}

const PAGE_SIZE = 50;
const BATCH_SIZE = 50;

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

export function extractShopifyNumericId(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1];
}

export function mapShopifyStatus(
  status: string,
): PutProductData["state"] & string {
  switch (status) {
    case "ACTIVE":
      return "AVAILABLE";
    case "DRAFT":
      return "LISTED";
    case "ARCHIVED":
      return "REMOVED";
    default:
      return "UNKNOWN";
  }
}

export function detectLanguage(_text: string): LocalizedTextData["language"] {
  return "en";
}

export function transformProduct(
  product: ShopifyProduct["node"],
  shopDomain: string,
): PutProductData {
  const shopsProductId = extractShopifyNumericId(product.id);
  const language = detectLanguage(product.title);

  const result: PutProductData = {
    shopsProductId,
    title: { text: product.title, language },
    description: {
      text: stripHtml(product.descriptionHtml),
      language,
    },
    state: mapShopifyStatus(product.status),
    url:
      product.onlineStoreUrl ??
      `https://${shopDomain}/products/${shopsProductId}`,
    images: product.images.edges.map((edge) => edge.node.url),
  };

  const firstVariant = product.variants.edges[0]?.node;
  if (firstVariant?.price) {
    const amount = Math.round(Number.parseFloat(firstVariant.price) * 100);
    const currencyCode =
      firstVariant.currencyCode.edges[0]?.node.price.currencyCode ?? "EUR";
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

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAllProducts(
  deps: BackfillDependencies,
): Promise<PutProductData[]> {
  const products: PutProductData[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await deps.graphqlRequest(PRODUCTS_QUERY, {
      first: PAGE_SIZE,
      after: cursor,
    });

    if (response.errors?.length) {
      throw new Error(
        `Shopify GraphQL error: ${response.errors.map((e) => e.message).join(", ")}`,
      );
    }

    const data = response.data?.products;
    if (!data) {
      throw new Error("Unexpected Shopify GraphQL response: missing products");
    }

    for (const edge of data.edges) {
      products.push(transformProduct(edge.node, deps.shopDomain));
    }

    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
  }

  return products;
}

async function sendProductBatch(
  products: PutProductData[],
  deps: BackfillDependencies,
): Promise<string[]> {
  const client = createClient({ baseUrl: deps.apiBaseUrl });
  const { putPartnerProducts } = await import("./generated/api/sdk.gen");

  const result = await putPartnerProducts({
    client,
    body: products,
    path: { shopId: deps.shopId },
    headers: {
      "x-api-key": deps.apiKey,
    },
  });

  if (result.error) {
    const status = result.response?.status ?? "unknown";
    throw new Error(`API error ${status}: ${JSON.stringify(result.error)}`);
  }

  return (result.data as string[]) ?? [];
}

export async function backfillProducts(
  deps: BackfillDependencies,
): Promise<{ total: number; failures: string[] }> {
  const products = await fetchAllProducts(deps);

  if (products.length === 0) {
    return { total: 0, failures: [] };
  }

  const allFailures: string[] = [];

  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    try {
      const failures = await sendProductBatch(batch, deps);
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

  return { total: products.length, failures: allFailures };
}

export async function triggerBackfill(
  deps: BackfillDependencies,
): Promise<void> {
  try {
    const result = await backfillProducts(deps);
    console.log(
      `Product backfill complete: ${result.total} products, ${result.failures.length} failures`,
    );
    if (result.failures.length > 0) {
      console.warn("Failed product IDs:", result.failures.join(", "));
    }
  } catch (error) {
    console.error("Product backfill failed:", error);
  }
}
