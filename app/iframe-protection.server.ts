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
  responseHeaders.set("Referrer-Policy", "no-referrer");
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

export function protectPrivateResponse(request: Request, response: Response) {
  const url = new URL(request.url);
  if (
    /^\/(?:app|auth|oauth|webhooks)(?:\/|\.data$|$)/.test(url.pathname) ||
    url.searchParams.has("id_token")
  ) {
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
}
