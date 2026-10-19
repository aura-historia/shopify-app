import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  buildAuraHistoriaOAuthAuthorizeUrl,
  getOAuthPendingContextStorageKey,
} from "../app/oauth.server";

// Node cannot load the route's CSS module, which the loader does not use.
registerHooks({
  resolve: (specifier, context, nextResolve) =>
    specifier.endsWith(".module.css")
      ? { url: "data:text/javascript,export default {}", shortCircuit: true }
      : nextResolve(specifier, context),
});
const { loader } = await import("../app/routes/oauth.callback");

const clientSecret = "qa-synthetic-client-secret-not-real";
const accessToken = "synthetic-access-token-marker";
const code = "synthetic-authorization-code";
const shopDomain = "example-shop.myshopify.com";
const listingSourceId = `ls_${"0".repeat(26)}`;
// Long enough to catch a credential prefix left behind by truncation.
const leakPrefixLength = 8;

let logged: string[];

function makeKv() {
  const entries = new Map<string, string>();
  return {
    entries,
    get: async (key: string) => entries.get(key) ?? null,
    put: async (key: string, value: string) => {
      entries.set(key, value);
    },
    delete: async (key: string) => {
      entries.delete(key);
    },
  };
}

function makeEnv(prepareConnection = async () => {}) {
  return {
    KV: makeKv(),
    AURA_HISTORIA_OAUTH_CLIENT_ID: "oc_01h455vb4pex5vy7enb1p677vn",
    AURA_HISTORIA_OAUTH_CLIENT_SECRET: clientSecret,
    AURA_HISTORIA_OAUTH_TOKEN_URL: "https://api.test.com/api/v1/oauth/token",
    SHOPIFY_APP_URL: "https://partner-connect.test",
    SHOP_COORDINATOR: { getByName: () => ({ prepareConnection }) },
  };
}

// Mirrors the stage backend, which echoes submitted credentials in `detail`.
function rejectEchoingCredentials(init?: RequestInit) {
  const body = new URLSearchParams(init?.body as URLSearchParams);
  return Response.json(
    {
      status: 401,
      title: "Unauthorized",
      error: "OAUTH_INVALID_CLIENT_SECRET",
      detail: ["client_secret", "code_verifier", "token"]
        .flatMap((name) => body.get(name) ?? [])
        .map((value) => `RawToken '${value}' is invalid`)
        .join("; "),
    },
    { status: 401 },
  );
}

async function runCallback(env: ReturnType<typeof makeEnv>) {
  const started = await buildAuraHistoriaOAuthAuthorizeUrl(
    env.KV as never,
    env as never,
    shopDomain,
  );
  assert.ok(started.isReady);
  const pendingKey = getOAuthPendingContextStorageKey(started.state);
  const { codeVerifier } = JSON.parse(env.KV.entries.get(pendingKey) ?? "");

  const url = new URL("https://partner-connect.test/oauth/callback");
  url.searchParams.set("code", code);
  url.searchParams.set("state", started.state);
  url.searchParams.set("listing_source_id", listingSourceId);
  const response = await loader({
    request: new Request(url),
    context: { cloudflare: { env } },
    params: {},
  } as never);

  assert.ok(response instanceof Response);
  assert.equal(response.status, 302);
  const location = response.headers.get("Location") ?? "";
  const redirect = new URL(location);
  assert.equal(redirect.origin, "https://admin.shopify.com");
  assert.equal(redirect.searchParams.get("oauth"), "failed");
  assert.equal(env.KV.entries.has(pendingKey), false);

  return {
    location,
    oauthError: redirect.searchParams.get("oauth_error") ?? "",
    codeVerifier: codeVerifier as string,
  };
}

function assertNoCredentials(outputs: string[], credentials: string[]) {
  for (const output of outputs) {
    for (const credential of credentials) {
      assert.equal(
        output.includes(credential.slice(0, leakPrefixLength)),
        false,
        `credential leaked into: ${output}`,
      );
    }
  }
}

describe("Aura Historia OAuth callback error boundary", () => {
  beforeEach(() => {
    logged = [];
    for (const method of ["log", "info", "warn", "error"] as const) {
      mock.method(console, method, (...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      });
    }
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("keeps token-exchange problem details out of the Admin redirect and logs", async () => {
    mock.method(
      globalThis,
      "fetch",
      async (_input: unknown, init?: RequestInit) =>
        rejectEchoingCredentials(init),
    );

    const { location, oauthError, codeVerifier } = await runCallback(makeEnv());

    assertNoCredentials(
      [location, oauthError, ...logged],
      [clientSecret, codeVerifier],
    );
    assert.equal(
      oauthError,
      "OAuth token exchange failed (HTTP 401, OAUTH_INVALID_CLIENT_SECRET)",
    );
  });

  it("redacts credentials before truncating post-exchange errors", async () => {
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (input: unknown, init?: RequestInit) =>
        String(input).endsWith("/token")
          ? Response.json({
              access_token: accessToken,
              token_type: "BEARER",
              scope: "listing-sources:write",
            })
          : rejectEchoingCredentials(init),
    );
    // The access token straddles the 180-character summary limit.
    const env = makeEnv(async () => {
      throw new Error(`${"x".repeat(165)}${accessToken} ${clientSecret}`);
    });

    const { location, oauthError, codeVerifier } = await runCallback(env);

    assertNoCredentials(
      [location, oauthError, ...logged],
      [clientSecret, accessToken, codeVerifier],
    );
    assert.equal(oauthError, `${"x".repeat(165)}[redacted] [red`);
    assert.equal(fetchMock.mock.callCount(), 2);
    assert.equal(
      String(fetchMock.mock.calls[1]?.arguments[0]),
      "https://api.test.com/api/v1/oauth/revoke",
    );
    assert.deepEqual(logged, [
      "Failed to revoke token after connection setup failure: OAuth token revocation failed (HTTP 401, OAUTH_INVALID_CLIENT_SECRET)",
    ]);
  });
});
