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

// Shopify's managed-installation page for this app. For an installation with
// pending required scopes it asks the merchant to approve the updated access,
// then returns to the app.
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
