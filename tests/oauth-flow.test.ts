import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  buildAuraHistoriaOAuthAuthorizeUrl,
  connectAuraHistoriaShop,
  createShopifyAdminAppUrl,
  decodeOAuthState,
  exchangeOAuthCodeForToken,
  getAuraHistoriaOAuthConfig,
  getMissingAuraHistoriaOAuthConfig,
  isValidOAuthClientId,
  loadOAuthPendingContext,
} from "../app/oauth.server";
import {
  getShopCredentialsStorageKey,
  loadShopCredentials,
} from "../app/shop-credentials.server";

const clientId = "oc_01h455vb4pex5vy7enb1p677vn";
const listingSourceId = `ls_${"0".repeat(26)}`;
const credentials = {
  listingSourceId,
  accessToken: "aurahistoria_partner_token",
};
const config = {
  authorizeUrl: "https://stage.aura-historia.com/oauth/authorize",
  tokenUrl: "https://api.test.com/api/v1/oauth/token",
  redirectUri: "https://shopify.test/callback",
  clientId,
  clientSecret: "client-secret",
  scope: "listing-sources:write product-listings:write",
};

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
      AURA_HISTORIA_OAUTH_CLIENT_ID: clientId,
      AURA_HISTORIA_OAUTH_CLIENT_SECRET: "secret",
      SHOPIFY_APP_URL: "https://partner-connect.aura-historia.com",
    } as never);
    const prodConfig = getAuraHistoriaOAuthConfig({
      AURA_HISTORIA_OAUTH_ENV: "production",
      AURA_HISTORIA_OAUTH_CLIENT_ID: clientId,
      AURA_HISTORIA_OAUTH_CLIENT_SECRET: "secret",
      SHOPIFY_APP_URL: "https://partner-connect.aura-historia.com",
    } as never);

    assert.equal(
      devConfig.authorizeUrl,
      "https://stage.aura-historia.com/oauth/authorize",
    );
    assert.equal(
      prodConfig.authorizeUrl,
      "https://aura-historia.com/oauth/authorize",
    );
    assert.equal(
      devConfig.tokenUrl,
      "https://api.stage.aura-historia.com/api/v1/oauth/token",
    );
    assert.equal(
      prodConfig.tokenUrl,
      "https://api.aura-historia.com/api/v1/oauth/token",
    );
    assert.equal(
      devConfig.scope,
      "listing-sources:write product-listings:write",
    );
  });

  it("builds the authorize URL with listing-source requirement, PKCE, and base64 state", async () => {
    const kv = makeKv();
    const env = {
      AURA_HISTORIA_OAUTH_ENV: "dev",
      AURA_HISTORIA_OAUTH_CLIENT_ID: clientId,
      AURA_HISTORIA_OAUTH_CLIENT_SECRET: "secret",
      SHOPIFY_APP_URL: "https://partner-connect.aura-historia.com",
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
      authorization.url.searchParams.get("requires_listing_source_id"),
      "true",
    );
    assert.equal(
      authorization.url.searchParams.has("requires_partner_shop_id"),
      false,
    );
    assert.equal(
      authorization.url.searchParams.get("scope"),
      "listing-sources:write product-listings:write",
    );
    assert.equal(authorization.url.searchParams.get("client_id"), clientId);
    assert.equal(authorization.url.searchParams.get("response_type"), "code");
    assert.equal(
      authorization.url.searchParams.get("redirect_uri"),
      "https://partner-connect.aura-historia.com/oauth/callback",
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
      "https://partner-connect.aura-historia.com/oauth/callback",
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
        assert.equal(body.get("client_id"), clientId);
        assert.equal(body.get("client_secret"), "client-secret");
        assert.equal(body.get("code_verifier"), "code-verifier");

        return new Response(
          JSON.stringify({
            access_token: "aurahistoria_partner_token",
            token_type: "BEARER",
            expires_in: null,
            scope: "listing-sources:write product-listings:write",
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
          clientId,
          clientSecret: "client-secret",
          scope: "listing-sources:write product-listings:write",
        },
        "oauth-code",
        "code-verifier",
      );

      assert.equal(token.access_token, "aurahistoria_partner_token");
      assert.equal(token.scope, "listing-sources:write product-listings:write");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects noncanonical OAuth client IDs before creating an authorize URL", async () => {
    for (const invalid of [
      "019eb09e-563a-7ad2-8e71-1ae86f8430ab",
      "oc_not-a-typeid",
      "OC_01h455vb4pex5vy7enb1p677vn",
      "ls_01h455vb4pex5vy7enb1p677vn",
      "oc_REPLACE_WITH_PRODUCTION_OAUTH_CLIENT_ID",
    ]) {
      assert.equal(isValidOAuthClientId(invalid), false);
      const oauthConfig = { ...config, clientId: invalid };
      assert.deepEqual(getMissingAuraHistoriaOAuthConfig(oauthConfig), [
        "AURA_HISTORIA_OAUTH_CLIENT_ID",
      ]);
      const kv = makeKv();
      const result = await buildAuraHistoriaOAuthAuthorizeUrl(
        kv as never,
        {
          AURA_HISTORIA_OAUTH_CLIENT_ID: invalid,
          AURA_HISTORIA_OAUTH_CLIENT_SECRET: "secret",
        } as never,
        "example-shop.myshopify.com",
      );
      assert.deepEqual(result, {
        isReady: false,
        missing: ["AURA_HISTORIA_OAUTH_CLIENT_ID"],
      });
      assert.equal(kv.put.mock.callCount(), 0);
    }
    assert.equal(isValidOAuthClientId(clientId), true);
    assert.deepEqual(getMissingAuraHistoriaOAuthConfig(config), []);
  });

  it("configures the provider before saving credentials, then queues and stores context", async () => {
    const kv = makeKv();
    const shopDomain = "example-shop.myshopify.com";
    const events: string[] = [];
    let finishProvider!: () => void;
    const provider = new Promise<void>((resolve) => {
      finishProvider = resolve;
    });
    let finishSave!: () => void;
    const save = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    kv.put.mock.mockImplementation(async (key: string, value: string) => {
      events.push(
        key === getShopCredentialsStorageKey(shopDomain) ? "save" : "context",
      );
      if (key === getShopCredentialsStorageKey(shopDomain)) await save;
      kv._entries.set(key, value);
    });
    const connection = connectAuraHistoriaShop(
      kv as never,
      shopDomain,
      credentials,
      config,
      async () => {
        events.push("provider PUT");
        await provider;
        return { currencyCode: "EUR" };
      },
      async () => {
        events.push("bulk submission");
        assert.equal(
          (await loadShopCredentials(kv as never, shopDomain))?.accessToken,
          credentials.accessToken,
        );
        await kv.put("backfill-context", "context");
        return "queued";
      },
    );
    assert.deepEqual(events, ["provider PUT"]);
    assert.equal(kv.put.mock.callCount(), 0);
    finishProvider();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(events, ["provider PUT", "save"]);
    finishSave();
    assert.equal(await connection, "queued");
    assert.deepEqual(events, [
      "provider PUT",
      "save",
      "bulk submission",
      "context",
    ]);
  });

  it("revokes the newly issued token if provider setup fails before persistence", async () => {
    const kv = makeKv();
    const queue = mock.fn(async () => "queued" as const);
    const originalFetch = globalThis.fetch;
    const revoke = mock.fn(
      async (_request: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    globalThis.fetch = revoke as typeof fetch;
    try {
      await assert.rejects(
        connectAuraHistoriaShop(
          kv as never,
          "example-shop.myshopify.com",
          credentials,
          config,
          async () => {
            throw new Error("Provider PUT failed");
          },
          queue,
        ),
        /Provider PUT failed/,
      );
      assert.equal(queue.mock.callCount(), 0);
      assert.equal(kv.put.mock.callCount(), 0);
      assert.equal(revoke.mock.callCount(), 1);
      assert.equal(
        new URL(revoke.mock.calls[0]?.arguments[0] as string).pathname,
        "/api/v1/oauth/revoke",
      );
      assert.equal(
        new URLSearchParams(
          revoke.mock.calls[0]?.arguments[1]?.body as URLSearchParams,
        ).get("token"),
        credentials.accessToken,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("revokes the new token and skips bulk submission when credential storage fails", async () => {
    const kv = makeKv();
    kv.put.mock.mockImplementation(async () => {
      throw new Error("KV write failed");
    });
    const queue = mock.fn(async () => "queued" as const);
    const originalFetch = globalThis.fetch;
    const revoke = mock.fn(
      async (_request: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    globalThis.fetch = revoke as typeof fetch;
    try {
      await assert.rejects(
        connectAuraHistoriaShop(
          kv as never,
          "example-shop.myshopify.com",
          credentials,
          config,
          async () => ({ currencyCode: "EUR" }),
          queue,
        ),
        /KV write failed/,
      );
      assert.equal(queue.mock.callCount(), 0);
      assert.equal(
        await loadShopCredentials(kv as never, "example-shop.myshopify.com"),
        null,
      );
      assert.equal(revoke.mock.callCount(), 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the connection when bulk submission fails, so it can be retried without OAuth", async () => {
    const kv = makeKv();
    const originalFetch = globalThis.fetch;
    const revoke = mock.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = revoke as typeof fetch;
    const shopDomain = "example-shop.myshopify.com";
    const queue = mock.fn(async () => {
      throw new Error("bulk failed");
    });
    try {
      const result = await connectAuraHistoriaShop(
        kv as never,
        shopDomain,
        credentials,
        config,
        async () => ({ currencyCode: "EUR" }),
        queue,
      );
      assert.equal(result, "not_queued");
      assert.equal(
        (await loadShopCredentials(kv as never, shopDomain))?.accessToken,
        credentials.accessToken,
      );
      assert.equal(revoke.mock.callCount(), 0);
      // Retry uses the durable credential, not another token exchange.
      assert.equal(
        (await loadShopCredentials(kv as never, shopDomain))?.listingSourceId,
        listingSourceId,
      );
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
