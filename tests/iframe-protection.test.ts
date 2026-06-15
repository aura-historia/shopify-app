import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDocumentResponseHeaders } from "../app/iframe-protection.server";

describe("iframe protection", () => {
  it("allows the authenticated shop and Shopify admin to frame the app", () => {
    const headers = new Headers();

    addDocumentResponseHeaders(
      new Request(
        "https://partner-connect.aura-historia.com/app?shop=example-store.myshopify.com&host=test",
      ),
      headers,
    );

    assert.equal(
      headers.get("Content-Security-Policy"),
      "frame-ancestors https://example-store.myshopify.com https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;",
    );
  });

  it("denies framing on public fallback pages", () => {
    const headers = new Headers();

    addDocumentResponseHeaders(
      new Request("https://partner-connect.aura-historia.com/auth/login"),
      headers,
    );

    assert.equal(
      headers.get("Content-Security-Policy"),
      "frame-ancestors 'none';",
    );
  });

  it("allows public document routes to render in Shopify when the shop is known", () => {
    const headers = new Headers();

    addDocumentResponseHeaders(
      new Request(
        "https://partner-connect.aura-historia.com/auth/login?shop=example-store.myshopify.com",
      ),
      headers,
    );

    assert.equal(
      headers.get("Content-Security-Policy"),
      "frame-ancestors https://example-store.myshopify.com https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;",
    );
  });

  it("denies framing when the shop parameter is missing", () => {
    const headers = new Headers();

    addDocumentResponseHeaders(
      new Request("https://partner-connect.aura-historia.com/auth"),
      headers,
    );

    assert.equal(
      headers.get("Content-Security-Policy"),
      "frame-ancestors 'none';",
    );
  });

  it("ignores invalid shop values before building the embedded CSP header", () => {
    const headers = new Headers();

    addDocumentResponseHeaders(
      new Request(
        "https://partner-connect.aura-historia.com/app?shop=example-store.myshopify.com%3Bhttps://evil.example",
      ),
      headers,
    );

    assert.equal(
      headers.get("Content-Security-Policy"),
      "frame-ancestors 'none';",
    );
  });
});
