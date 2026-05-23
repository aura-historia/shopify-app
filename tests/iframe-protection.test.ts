import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDocumentResponseHeaders } from "../app/iframe-protection.server";

describe("iframe protection", () => {
  it("allows the authenticated shop and Shopify admin to frame the app", () => {
    const headers = new Headers();

    addDocumentResponseHeaders(
      new Request(
        "https://shopify.aura-historia.com/app?shop=example-store.myshopify.com&host=test",
      ),
      headers,
    );

    assert.equal(
      headers.get("Content-Security-Policy"),
      "frame-ancestors https://example-store.myshopify.com https://admin.shopify.com;",
    );
  });

  it("falls back to denying framing when the shop parameter is missing", () => {
    const headers = new Headers();

    addDocumentResponseHeaders(
      new Request("https://shopify.aura-historia.com/auth/login"),
      headers,
    );

    assert.equal(
      headers.get("Content-Security-Policy"),
      "frame-ancestors 'none';",
    );
  });

  it("ignores invalid shop values before building the CSP header", () => {
    const headers = new Headers();

    addDocumentResponseHeaders(
      new Request(
        "https://shopify.aura-historia.com/app?shop=example-store.myshopify.com%3Bhttps://evil.example",
      ),
      headers,
    );

    assert.equal(
      headers.get("Content-Security-Policy"),
      "frame-ancestors 'none';",
    );
  });
});
