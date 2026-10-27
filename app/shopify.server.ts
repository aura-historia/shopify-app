import "@shopify/shopify-api/adapters/cf-worker";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { KVSessionStorage } from "@shopify/shopify-app-session-storage-kv";
import type { AppLoadContext } from "react-router";

export interface CloudflareShopifyEnv {
  SHOP_COORDINATOR: CloudflareBindings["SHOP_COORDINATOR"];
  CATALOG_IMPORTER: CloudflareBindings["CATALOG_IMPORTER"];
  KV: CloudflareBindings["KV"];
  SCOPES?: string;
  SHOPIFY_API_KEY?: string;
  SHOPIFY_API_SECRET?: string;
  SHOPIFY_APP_URL?: string;
  SHOPIFY_API_VERSION?: string;
  AURA_HISTORIA_API_BASE_URL?: string;
  AURA_HISTORIA_ENV?: string;
  AURA_HISTORIA_OAUTH_ENV?: string;
  AURA_HISTORIA_OAUTH_AUTHORIZE_URL?: string;
  AURA_HISTORIA_OAUTH_TOKEN_URL?: string;
  AURA_HISTORIA_OAUTH_REDIRECT_URI?: string;
  AURA_HISTORIA_OAUTH_CLIENT_ID?: string;
  AURA_HISTORIA_OAUTH_CLIENT_SECRET?: string;
  AURA_HISTORIA_OAUTH_SCOPE?: string;
}

const apiVersion = ApiVersion.October26;
const shopifyCache = new WeakMap<
  CloudflareBindings["KV"],
  Map<string, ReturnType<typeof shopifyApp>>
>();

function getEnv(context: AppLoadContext): CloudflareShopifyEnv {
  return context.cloudflare.env;
}

function getResolvedConfig(env: CloudflareShopifyEnv) {
  return {
    apiKey: env.SHOPIFY_API_KEY ?? process.env.SHOPIFY_API_KEY ?? "",
    apiSecretKey:
      env.SHOPIFY_API_SECRET ?? process.env.SHOPIFY_API_SECRET ?? "",
    appUrl: env.SHOPIFY_APP_URL ?? process.env.SHOPIFY_APP_URL ?? "",
    scopes: getScopes(env.SCOPES ?? process.env.SCOPES),
  };
}

function getCacheKey(env: CloudflareShopifyEnv) {
  const config = getResolvedConfig(env);

  return [
    config.apiKey,
    config.apiSecretKey,
    config.appUrl,
    config.scopes.join(","),
  ].join("|");
}

function getScopes(scopes: string | undefined) {
  return (
    scopes
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean) ?? []
  );
}

export function getShopify(context: AppLoadContext) {
  return getShopifyForEnv(getEnv(context));
}

export function getShopifyWebhook(context: AppLoadContext) {
  return getShopifyForEnv(getEnv(context), true);
}

export function getShopifyForEnv(
  env: CloudflareShopifyEnv,
  webhookOnly = false,
) {
  const config = getResolvedConfig(env);
  const cacheKey = `${getCacheKey(env)}|${webhookOnly}`;
  let bindingCache = shopifyCache.get(env.KV);
  if (!bindingCache) {
    bindingCache = new Map();
    shopifyCache.set(env.KV, bindingCache);
  }
  const cached = bindingCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const shopify = shopifyApp({
    apiKey: config.apiKey,
    apiSecretKey: config.apiSecretKey,
    apiVersion,
    scopes: config.scopes,
    appUrl: config.appUrl,
    authPathPrefix: "/auth",
    sessionStorage: new KVSessionStorage(env.KV),
    distribution: AppDistribution.AppStore,
    future: {
      // authenticate.webhook normally refreshes expiring offline access too.
      // HMAC authentication needs only the stored installation. All job token
      // refresh belongs to the shop coordinator's serialized GraphQL path.
      expiringOfflineAccessTokens: !webhookOnly,
    },
  });

  bindingCache.set(cacheKey, shopify);

  return shopify;
}

export function getShopifyApiKey(context: AppLoadContext) {
  return getResolvedConfig(getEnv(context)).apiKey;
}
