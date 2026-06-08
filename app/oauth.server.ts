import type { KVNamespace } from "@cloudflare/workers-types";
import type { OAuthTokenResponseData } from "./generated/api/types.gen";
import type { CloudflareShopifyEnv } from "./shopify.server";
import {
  createShopifyAdminAppUrl,
  getShopifyStoreName,
} from "./shopify-admin-url";

export interface AuraHistoriaOAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

export interface OAuthState {
  shopify_store_name: string;
  nonce: string;
}

export interface OAuthPendingContext {
  shopDomain: string;
  shopifyStoreName: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: string;
}

export type BuildOAuthAuthorizeUrlResult =
  | {
      isReady: true;
      url: URL;
      state: string;
      shopifyStoreName: string;
    }
  | {
      isReady: false;
      missing: string[];
    };

const AURA_HISTORIA_STAGE_AUTHORIZE_URL =
  "https://stage.aura-historia.com/oauth/authorize";
const AURA_HISTORIA_PROD_AUTHORIZE_URL =
  "https://aura-historia.com/oauth/authorize";
const AURA_HISTORIA_DEV_API_BASE_URL = "https://api.dev.aura-historia.com";
const AURA_HISTORIA_PROD_API_BASE_URL = "https://api.aura-historia.com";
const SHOPIFY_APP_PROD_URL = "https://shopify.aura-historia.com";
const OAUTH_SCOPE = "products:write";
const OAUTH_PENDING_CONTEXT_KEY_PREFIX = "aura-historia:oauth-pending:";
const OAUTH_PENDING_CONTEXT_TTL_SECONDS = 10 * 60;
const SHOPIFY_STORE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

type StringEnvKey = Exclude<keyof CloudflareShopifyEnv, "KV">;

function envValue(env: CloudflareShopifyEnv, key: StringEnvKey) {
  const value = env[key];
  return typeof value === "string" ? value : process.env[key];
}

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function getRequestedOAuthEnvironment(env: CloudflareShopifyEnv) {
  return (
    envValue(env, "AURA_HISTORIA_OAUTH_ENV") ??
    envValue(env, "AURA_HISTORIA_ENV") ??
    ""
  ).toLowerCase();
}

function resolveAuthorizeUrl(env: CloudflareShopifyEnv) {
  const explicitUrl = envValue(env, "AURA_HISTORIA_OAUTH_AUTHORIZE_URL");
  if (explicitUrl) {
    return explicitUrl;
  }

  const requestedEnvironment = getRequestedOAuthEnvironment(env);
  if (["prod", "production"].includes(requestedEnvironment)) {
    return AURA_HISTORIA_PROD_AUTHORIZE_URL;
  }
  if (
    ["dev", "stage", "staging", "development"].includes(requestedEnvironment)
  ) {
    return AURA_HISTORIA_STAGE_AUTHORIZE_URL;
  }

  const apiBaseUrl = getAuraHistoriaApiBaseUrl(env);
  if (apiBaseUrl?.includes("api.aura-historia.com")) {
    return AURA_HISTORIA_PROD_AUTHORIZE_URL;
  }

  return AURA_HISTORIA_STAGE_AUTHORIZE_URL;
}

function resolveDefaultApiBaseUrl(authorizeUrl: string) {
  const hostname = new URL(authorizeUrl).hostname;
  return hostname === "aura-historia.com"
    ? AURA_HISTORIA_PROD_API_BASE_URL
    : AURA_HISTORIA_DEV_API_BASE_URL;
}

export function getAuraHistoriaApiBaseUrl(env: CloudflareShopifyEnv) {
  const value = envValue(env, "AURA_HISTORIA_API_BASE_URL");
  return value ? normalizeBaseUrl(value) : undefined;
}

export function getAuraHistoriaOAuthConfig(
  env: CloudflareShopifyEnv,
): AuraHistoriaOAuthConfig {
  const authorizeUrl = resolveAuthorizeUrl(env);
  const apiBaseUrl =
    getAuraHistoriaApiBaseUrl(env) ?? resolveDefaultApiBaseUrl(authorizeUrl);
  const appUrl = envValue(env, "SHOPIFY_APP_URL") ?? SHOPIFY_APP_PROD_URL;
  const redirectUri =
    envValue(env, "AURA_HISTORIA_OAUTH_REDIRECT_URI") ??
    new URL("/oauth/callback", appUrl || SHOPIFY_APP_PROD_URL).toString();

  return {
    authorizeUrl,
    tokenUrl:
      envValue(env, "AURA_HISTORIA_OAUTH_TOKEN_URL") ??
      `${apiBaseUrl}/api/v1/oauth/token`,
    redirectUri,
    clientId: envValue(env, "AURA_HISTORIA_OAUTH_CLIENT_ID") ?? "",
    clientSecret: envValue(env, "AURA_HISTORIA_OAUTH_CLIENT_SECRET") ?? "",
    scope: envValue(env, "AURA_HISTORIA_OAUTH_SCOPE") ?? OAUTH_SCOPE,
  };
}

export function getMissingAuraHistoriaOAuthConfig(
  config: AuraHistoriaOAuthConfig,
) {
  const missing: string[] = [];

  if (!config.clientId) {
    missing.push("AURA_HISTORIA_OAUTH_CLIENT_ID");
  }
  if (!config.clientSecret) {
    missing.push("AURA_HISTORIA_OAUTH_CLIENT_SECRET");
  }

  return missing;
}

export { createShopifyAdminAppUrl, getShopifyStoreName };

export function getShopDomainFromStoreName(shopifyStoreName: string) {
  return `${shopifyStoreName.toLowerCase()}.myshopify.com`;
}

export function isValidShopifyStoreName(value: string) {
  return SHOPIFY_STORE_NAME_PATTERN.test(value);
}

function encodeBase64(value: string) {
  return btoa(value);
}

function decodeBase64(value: string) {
  return atob(value.replace(/-/g, "+").replace(/_/g, "/"));
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomBase64Url(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function encodeOAuthState(state: OAuthState) {
  return encodeBase64(JSON.stringify(state));
}

export function decodeOAuthState(value: string): OAuthState | null {
  try {
    const parsed: unknown = JSON.parse(decodeBase64(value));
    if (
      parsed &&
      typeof parsed === "object" &&
      "shopify_store_name" in parsed &&
      typeof parsed.shopify_store_name === "string" &&
      isValidShopifyStoreName(parsed.shopify_store_name) &&
      "nonce" in parsed &&
      typeof parsed.nonce === "string"
    ) {
      return parsed as OAuthState;
    }
  } catch {
    return null;
  }

  return null;
}

export function getOAuthPendingContextStorageKey(state: string) {
  return `${OAUTH_PENDING_CONTEXT_KEY_PREFIX}${state}`;
}

export async function storeOAuthPendingContext(
  kv: KVNamespace,
  state: string,
  context: OAuthPendingContext,
) {
  await kv.put(
    getOAuthPendingContextStorageKey(state),
    JSON.stringify(context),
    {
      expirationTtl: OAUTH_PENDING_CONTEXT_TTL_SECONDS,
    },
  );
}

export async function loadOAuthPendingContext(
  kv: KVNamespace,
  state: string,
): Promise<OAuthPendingContext | null> {
  const rawValue = await kv.get(getOAuthPendingContextStorageKey(state));
  if (!rawValue) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawValue);
    if (
      parsed &&
      typeof parsed === "object" &&
      "shopDomain" in parsed &&
      typeof parsed.shopDomain === "string" &&
      "shopifyStoreName" in parsed &&
      typeof parsed.shopifyStoreName === "string" &&
      "codeVerifier" in parsed &&
      typeof parsed.codeVerifier === "string" &&
      "redirectUri" in parsed &&
      typeof parsed.redirectUri === "string" &&
      "createdAt" in parsed &&
      typeof parsed.createdAt === "string"
    ) {
      return parsed as OAuthPendingContext;
    }
  } catch {
    return null;
  }

  return null;
}

export async function clearOAuthPendingContext(kv: KVNamespace, state: string) {
  await kv.delete(getOAuthPendingContextStorageKey(state));
}

export async function createPkcePair() {
  const codeVerifier = randomBase64Url(32);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );

  return {
    codeVerifier,
    codeChallenge: base64UrlEncode(new Uint8Array(digest)),
  };
}

export async function buildAuraHistoriaOAuthAuthorizeUrl(
  kv: KVNamespace,
  env: CloudflareShopifyEnv,
  shopDomain: string,
): Promise<BuildOAuthAuthorizeUrlResult> {
  const config = getAuraHistoriaOAuthConfig(env);
  const missing = getMissingAuraHistoriaOAuthConfig(config);

  if (missing.length > 0) {
    return { isReady: false, missing };
  }

  const shopifyStoreName = getShopifyStoreName(shopDomain);
  const state = encodeOAuthState({
    shopify_store_name: shopifyStoreName,
    nonce: randomBase64Url(16),
  });
  const pkce = await createPkcePair();

  await storeOAuthPendingContext(kv, state, {
    shopDomain,
    shopifyStoreName,
    codeVerifier: pkce.codeVerifier,
    redirectUri: config.redirectUri,
    createdAt: new Date().toISOString(),
  });

  const authorizeUrl = new URL(config.authorizeUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", config.clientId);
  authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
  authorizeUrl.searchParams.set("scope", config.scope);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("requires_partner_shop_id", "true");
  authorizeUrl.searchParams.set("code_challenge", pkce.codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return { isReady: true, url: authorizeUrl, state, shopifyStoreName };
}

async function readOAuthProblem(response: Response) {
  try {
    const payload = (await response.json()) as {
      title?: string;
      error?: string;
      detail?: string;
    };

    return (
      payload.detail ??
      payload.error ??
      payload.title ??
      `OAuth token exchange failed with HTTP ${response.status}`
    );
  } catch {
    return `OAuth token exchange failed with HTTP ${response.status}`;
  }
}

export class OAuthTokenExchangeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OAuthTokenExchangeError";
  }
}

export async function exchangeOAuthCodeForToken(
  config: AuraHistoriaOAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<OAuthTokenResponseData> {
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", config.redirectUri);
  body.set("client_id", config.clientId);
  body.set("client_secret", config.clientSecret);
  body.set("code_verifier", codeVerifier);

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new OAuthTokenExchangeError(
      await readOAuthProblem(response),
      response.status,
    );
  }

  const tokenResponse = (await response.json()) as OAuthTokenResponseData;
  if (!tokenResponse.access_token) {
    throw new OAuthTokenExchangeError(
      "OAuth token response did not include an access token",
      response.status,
    );
  }

  return tokenResponse;
}

export async function revokeAuraHistoriaAccessToken(
  config: AuraHistoriaOAuthConfig,
  accessToken: string,
): Promise<void> {
  const body = new URLSearchParams();
  body.set("token", accessToken);
  body.set("client_id", config.clientId);
  body.set("client_secret", config.clientSecret);

  const response = await fetch(config.tokenUrl.replace(/\/token$/, "/revoke"), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!response.ok) {
    throw new OAuthTokenExchangeError(
      await readOAuthProblem(response),
      response.status,
    );
  }
}

export function summarizeOAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 180);
}
