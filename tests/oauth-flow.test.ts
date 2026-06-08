import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it, mock } from "node:test";
import {
  buildAuraHistoriaOAuthAuthorizeUrl,
  createShopifyAdminAppUrl,
  decodeOAuthState,
  exchangeOAuthCodeForToken,
  getAuraHistoriaOAuthConfig,
  loadOAuthPendingContext,
} from "../app/oauth.server";

function makeKv() {
  const entries = new Map<string, string>();
  return {
    get: mock.fn(async (key: string) => entries.get(key) ?? null),
    put: mock.fn(
      async (
        key: string,
        value: string,
        _opts?: { expirationTtl?: number },
      ) => {
        entries.set(key, value);
      },
    ),
    delete: mock.fn(async (key: string) => entries.delete(key)),
    _entries: entries,
  };
}

describe("Aura Historia OAuth flow helpers", () => {
  it("selects the stage authorize URL for dev and prod URL for production", () => {
    const devConfig = getAuraHistoriaOAuthConfig({
      AURA_HISTORIA_OAUTH_ENV: "dev",
      AURA_HISTORIA_OAUTH_CLIENT_ID: randomUUID(),
      AURA_HISTORIA_OAUTH_CLIENT_SECRET: "secret",
      SHOPIFY_APP_URL: "https://shopify.aura-historia.com",
    } as never);
    const prodConfig = getAuraHistoriaOAuthConfig({
      AURA_HISTORIA_OAUTH_ENV: "production",
      AURA_HISTORIA_OAUTH_CLIENT_ID: randomUUID(),
      AURA_HISTORIA_OAUTH_CLIENT_SECRET: "secret",
      SHOPIFY_APP_URL: "https://shopify.aura-historia.com",
    } as never);

    assert.equal(
      devConfig.authorizeUrl,
      "https://stage.aura-historia.com/oauth/authorize",
    );
    assert.equal(
      prodConfig.authorizeUrl,
      "https://aura-historia.com/oauth/authorize",
    );
  });

  it("builds the authorize URL with partner-shop requirement, PKCE, and base64 state", async () => {
    const kv = makeKv();
    const env = {
      AURA_HISTORIA_OAUTH_ENV: "dev",
      AURA_HISTORIA_OAUTH_CLIENT_ID: randomUUID(),
      AURA_HISTORIA_OAUTH_CLIENT_SECRET: "secret",
      SHOPIFY_APP_URL: "https://shopify.aura-historia.com",
    };

    const authorization = await buildAuraHistoriaOAuthAuthorizeUrl(
      kv as never,
      env as never,
      "Example-Shop.myshopify.com",
    );

    assert.equal(authorization.isReady, true);
    if (!authorization.isReady) return;

    assert.equal(
      authorization.url.origin + authorization.url.pathname,
      "https://stage.aura-historia.com/oauth/authorize",
    );
    assert.equal(
      authorization.url.searchParams.get("requires_partner_shop_id"),
      "true",
    );
    assert.equal(authorization.url.searchParams.get("response_type"), "code");
    assert.equal(
      authorization.url.searchParams.get("redirect_uri"),
      "https://shopify.aura-historia.com/oauth/callback",
    );
    assert.equal(
      authorization.url.searchParams.get("code_challenge_method"),
      "S256",
    );
    assert.ok(authorization.url.searchParams.get("code_challenge"));

    const state = decodeOAuthState(
      authorization.url.searchParams.get("state") ?? "",
    );
    assert.deepEqual(state?.shopify_store_name, "example-shop");
    assert.ok(state?.nonce);

    const pending = await loadOAuthPendingContext(
      kv as never,
      authorization.state,
    );
    assert.ok(pending);
    assert.equal(pending.shopDomain, "Example-Shop.myshopify.com");
    assert.equal(pending.shopifyStoreName, "example-shop");
    assert.equal("shopifyAccessToken" in pending, false);
    assert.equal(
      pending.redirectUri,
      "https://shopify.aura-historia.com/oauth/callback",
    );
    assert.ok(pending.codeVerifier);
    assert.deepEqual(kv.put.mock.calls[0]?.arguments[2], {
      expirationTtl: 600,
    });
  });

  it("exchanges authorization codes with the form-urlencoded OAuth token endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = mock.fn(
      async (request: RequestInfo | URL, init?: RequestInit) => {
        const received =
          request instanceof Request ? request : new Request(request, init);
        assert.equal(received.url, "https://api.test.com/api/v1/oauth/token");
        assert.equal(received.method, "POST");
        assert.equal(
          received.headers.get("Content-Type"),
          "application/x-www-form-urlencoded",
        );

        const body = new URLSearchParams(await received.text());
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("code"), "oauth-code");
        assert.equal(body.get("redirect_uri"), "https://shopify.test/callback");
        assert.equal(body.get("client_id"), "client-id");
        assert.equal(body.get("client_secret"), "client-secret");
        assert.equal(body.get("code_verifier"), "code-verifier");

        return new Response(
          JSON.stringify({
            access_token: "aurahistoria_partner_token",
            token_type: "BEARER",
            expires_in: null,
            scope: "products:write",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    );

    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const token = await exchangeOAuthCodeForToken(
        {
          authorizeUrl: "https://stage.aura-historia.com/oauth/authorize",
          tokenUrl: "https://api.test.com/api/v1/oauth/token",
          redirectUri: "https://shopify.test/callback",
          clientId: "client-id",
          clientSecret: "client-secret",
          scope: "products:write",
        },
        "oauth-code",
        "code-verifier",
      );

      assert.equal(token.access_token, "aurahistoria_partner_token");
      assert.equal(token.scope, "products:write");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("builds the embedded Shopify admin return URL", () => {
    const url = createShopifyAdminAppUrl("example-shop", {
      oauth: "connected",
      backfill: "queued",
    });

    assert.equal(
      url.toString(),
      "https://admin.shopify.com/store/example-shop/apps/aura-historia-partner-connect/app?oauth=connected&backfill=queued",
    );
  });
});
