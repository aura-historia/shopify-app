export function getShopifyStoreName(shopDomain: string) {
  return shopDomain.toLowerCase().replace(/\.myshopify\.com$/, "");
}

export function createShopifyAdminAppUrl(
  shopifyStoreName: string,
  params: Record<string, string | undefined> = {},
) {
  const url = new URL(
    `https://admin.shopify.com/store/${encodeURIComponent(
      shopifyStoreName,
    )}/apps/aura-historia-partner-connect/app`,
  );

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return url;
}
