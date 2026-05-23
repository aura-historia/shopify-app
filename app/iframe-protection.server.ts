const adminFrameAncestors = [
  "https://admin.shopify.com",
  "https://*.spin.dev",
  "https://admin.myshopify.io",
  "https://admin.shop.dev",
];
const myShopifyDomainPattern = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

function getEmbeddedShopDomain(request: Request) {
  const shop = new URL(request.url).searchParams.get("shop");
  const normalizedShop = shop?.trim().toLowerCase();

  if (!normalizedShop || !myShopifyDomainPattern.test(normalizedShop)) {
    return null;
  }

  return normalizedShop;
}

export function addDocumentResponseHeaders(
  request: Request,
  responseHeaders: Headers,
) {
  const shop = getEmbeddedShopDomain(request);

  if (!shop) {
    responseHeaders.set("Content-Security-Policy", "frame-ancestors 'none';");
    return;
  }

  responseHeaders.set(
    "Content-Security-Policy",
    `frame-ancestors https://${shop} ${adminFrameAncestors.join(" ")};`,
  );
}
