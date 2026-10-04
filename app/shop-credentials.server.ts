import type { KVNamespace } from "@cloudflare/workers-types";

export interface ShopCredentialsValues {
  listingSourceId: string;
  accessToken: string;
  shopifyStoreName?: string;
  tokenType?: string;
  scope?: string;
}

export interface ShopCredentialsRecord extends ShopCredentialsValues {
  updatedAt: string;
}

export interface PublicShopCredentialsRecord {
  listingSourceId: string;
  hasAccessToken: boolean;
  shopifyStoreName?: string;
  tokenType?: string;
  scope?: string;
  updatedAt: string;
}

const SHOP_CREDENTIALS_KEY_PREFIX = "aura-historia:shop-credentials:";
const SHOP_CREDENTIALS_DISCONNECTED_KEY_PREFIX =
  "aura-historia:shop-credentials-disconnected:";
const LISTING_SOURCE_ID_PATTERN = /^ls_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const ACCESS_TOKEN_PATTERN = /^aurahistoria(?:_[A-Za-z0-9-]+){2,}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isShopCredentialsRecord(
  value: unknown,
): value is ShopCredentialsRecord {
  return Boolean(
    isObject(value) &&
      typeof value.listingSourceId === "string" &&
      isValidListingSourceId(value.listingSourceId) &&
      typeof value.accessToken === "string" &&
      typeof value.updatedAt === "string" &&
      (value.shopifyStoreName === undefined ||
        typeof value.shopifyStoreName === "string") &&
      (value.tokenType === undefined || typeof value.tokenType === "string") &&
      (value.scope === undefined || typeof value.scope === "string"),
  );
}

export function getShopCredentialsStorageKey(shop: string) {
  return `${SHOP_CREDENTIALS_KEY_PREFIX}${shop.toLowerCase()}`;
}

export function getShopCredentialsDisconnectedStorageKey(shop: string) {
  return `${SHOP_CREDENTIALS_DISCONNECTED_KEY_PREFIX}${shop.toLowerCase()}`;
}

export function isValidListingSourceId(value: string) {
  return LISTING_SOURCE_ID_PATTERN.test(value);
}

export function isValidAuraHistoriaAccessToken(value: string) {
  return ACCESS_TOKEN_PATTERN.test(value);
}

export function toPublicShopCredentialsRecord(
  record: ShopCredentialsRecord,
): PublicShopCredentialsRecord {
  return {
    listingSourceId: record.listingSourceId,
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
    return isShopCredentialsRecord(parsedValue) ? parsedValue : null;
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
