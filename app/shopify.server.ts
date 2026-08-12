import "@shopify/shopify-api/adapters/cf-worker";
import type { KVNamespace } from "@cloudflare/workers-types";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { KVSessionStorage } from "@shopify/shopify-app-session-storage-kv";
import type { AppLoadContext } from "react-router";

export interface CloudflareShopifyEnv {
  KV: KVNamespace;
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

const apiVersion = ApiVersion.April26;
const shopifyCache = new Map<string, ReturnType<typeof shopifyApp>>();

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
  const env = getEnv(context);
  const config = getResolvedConfig(env);
  const cacheKey = getCacheKey(env);
  const cached = shopifyCache.get(cacheKey);

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
      expiringOfflineAccessTokens: true,
    },
  });

  shopifyCache.set(cacheKey, shopify);

  return shopify;
}

export function getShopifyApiKey(context: AppLoadContext) {
  return getResolvedConfig(getEnv(context)).apiKey;
}
