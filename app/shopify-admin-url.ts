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

// Shopify's installation page for this app, the page Shopify documents for
// requesting scopes an installation has not granted. Shopify also asks for
// added required scopes when the merchant next opens the app.
export function createShopifyPermissionsUrl(
  shopifyStoreName: string,
  clientId: string,
) {
  const url = new URL(
    `https://admin.shopify.com/store/${encodeURIComponent(
      shopifyStoreName,
    )}/oauth/install`,
  );
  url.searchParams.set("client_id", clientId);
  return url;
}
