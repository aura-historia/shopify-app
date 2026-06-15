import type { KVNamespace } from "@cloudflare/workers-types";

export interface ShopCredentialsValues {
  shopId: string;
  accessToken: string;
  shopifyStoreName?: string;
  tokenType?: string;
  scope?: string;
}

export interface ShopCredentialsRecord extends ShopCredentialsValues {
  updatedAt: string;
}

export interface PublicShopCredentialsRecord {
  shopId: string;
  hasAccessToken: boolean;
  shopifyStoreName?: string;
  tokenType?: string;
  scope?: string;
  updatedAt: string;
}

interface LegacyShopCredentialsRecord {
  shopId: string;
  apiKey: string;
  updatedAt: string;
}

const SHOP_CREDENTIALS_KEY_PREFIX = "aura-historia:shop-credentials:";
const SHOP_CREDENTIALS_DISCONNECTED_KEY_PREFIX =
  "aura-historia:shop-credentials-disconnected:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCESS_TOKEN_PATTERN = /^aurahistoria(?:_[A-Za-z0-9-]+){2,}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isLegacyShopCredentialsRecord(
  value: unknown,
): value is LegacyShopCredentialsRecord {
  return Boolean(
    isObject(value) &&
      typeof value.shopId === "string" &&
      typeof value.apiKey === "string" &&
      typeof value.updatedAt === "string",
  );
}

function isShopCredentialsRecord(
  value: unknown,
): value is ShopCredentialsRecord {
  return Boolean(
    isObject(value) &&
      typeof value.shopId === "string" &&
      typeof value.accessToken === "string" &&
      typeof value.updatedAt === "string" &&
      (value.shopifyStoreName === undefined ||
        typeof value.shopifyStoreName === "string") &&
      (value.tokenType === undefined || typeof value.tokenType === "string") &&
      (value.scope === undefined || typeof value.scope === "string"),
  );
}

function normalizeShopCredentialsRecord(
  value: unknown,
): ShopCredentialsRecord | null {
  if (isShopCredentialsRecord(value)) {
    return value;
  }

  if (isLegacyShopCredentialsRecord(value)) {
    return {
      shopId: value.shopId,
      accessToken: value.apiKey,
      tokenType: "BEARER",
      updatedAt: value.updatedAt,
    };
  }

  return null;
}

export function getShopCredentialsStorageKey(shop: string) {
  return `${SHOP_CREDENTIALS_KEY_PREFIX}${shop.toLowerCase()}`;
}

export function getShopCredentialsDisconnectedStorageKey(shop: string) {
  return `${SHOP_CREDENTIALS_DISCONNECTED_KEY_PREFIX}${shop.toLowerCase()}`;
}

export function isValidShopId(value: string) {
  return UUID_PATTERN.test(value);
}

export function isValidAuraHistoriaAccessToken(value: string) {
  return ACCESS_TOKEN_PATTERN.test(value);
}

export function toPublicShopCredentialsRecord(
  record: ShopCredentialsRecord,
): PublicShopCredentialsRecord {
  return {
    shopId: record.shopId,
    hasAccessToken: true,
    shopifyStoreName: record.shopifyStoreName,
    tokenType: record.tokenType,
    scope: record.scope,
    updatedAt: record.updatedAt,
  };
}

export async function loadShopCredentials(
  kv: KVNamespace,
  shop: string,
): Promise<ShopCredentialsRecord | null> {
  const rawValue = await kv.get(getShopCredentialsStorageKey(shop));

  if (!rawValue) {
    return null;
  }

  try {
    const parsedValue: unknown = JSON.parse(rawValue);
    return normalizeShopCredentialsRecord(parsedValue);
  } catch {
    return null;
  }
}

export async function saveShopCredentials(
  kv: KVNamespace,
  shop: string,
  values: ShopCredentialsValues,
): Promise<ShopCredentialsRecord> {
  const record = {
    ...values,
    tokenType: values.tokenType ?? "BEARER",
    updatedAt: new Date().toISOString(),
  };

  await kv.put(getShopCredentialsStorageKey(shop), JSON.stringify(record));

  return record;
}

export async function clearShopCredentials(kv: KVNamespace, shop: string) {
  await kv.delete(getShopCredentialsStorageKey(shop));
}

export async function isShopCredentialsDisconnected(
  kv: KVNamespace,
  shop: string,
) {
  return Boolean(await kv.get(getShopCredentialsDisconnectedStorageKey(shop)));
}

export async function markShopCredentialsDisconnected(
  kv: KVNamespace,
  shop: string,
) {
  await kv.put(
    getShopCredentialsDisconnectedStorageKey(shop),
    JSON.stringify({ disconnectedAt: new Date().toISOString() }),
  );
}

export async function clearShopCredentialsDisconnected(
  kv: KVNamespace,
  shop: string,
) {
  await kv.delete(getShopCredentialsDisconnectedStorageKey(shop));
}
