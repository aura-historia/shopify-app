const adminFrameAncestor = "https://admin.shopify.com";
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

  responseHeaders.set(
    "Content-Security-Policy",
    shop
      ? `frame-ancestors https://${shop} ${adminFrameAncestor};`
      : "frame-ancestors 'none';",
  );
}
