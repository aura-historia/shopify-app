const SHOPIFY_ADMIN_APP_HANDLE = "aura-historia-partner-connect";

export function getShopifyStoreName(shopDomain: string) {
  return shopDomain.toLowerCase().replace(/\.myshopify\.com$/, "");
}

function applySearchParams(
  url: URL,
  params: Record<string, string | undefined>,
) {
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url;
}

export function createShopifyAdminAppRootUrl(
  shopifyStoreName: string,
  params: Record<string, string | undefined> = {},
) {
  return applySearchParams(
    new URL(
      `https://admin.shopify.com/store/${encodeURIComponent(
        shopifyStoreName,
      )}/apps/${SHOPIFY_ADMIN_APP_HANDLE}`,
    ),
    params,
  );
}

export function createShopifyAdminAppUrl(
  shopifyStoreName: string,
  params: Record<string, string | undefined> = {},
) {
  return applySearchParams(
    new URL(
      `https://admin.shopify.com/store/${encodeURIComponent(
        shopifyStoreName,
      )}/apps/${SHOPIFY_ADMIN_APP_HANDLE}/app`,
    ),
    params,
  );
}
