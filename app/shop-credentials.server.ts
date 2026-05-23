import type { KVNamespace } from "@cloudflare/workers-types";

export interface ShopCredentialsValues {
  shopId: string;
  apiKey: string;
}

export interface ShopCredentialsErrors {
  shopId?: string;
  apiKey?: string;
}

export interface ShopCredentialsValidationResult {
  errors: ShopCredentialsErrors;
  isValid: boolean;
  values: ShopCredentialsValues;
}

export interface ShopCredentialsRecord extends ShopCredentialsValues {
  updatedAt: string;
}

const SHOP_CREDENTIALS_KEY_PREFIX = "aura-historia:shop-credentials:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_KEY_PATTERN = /^aurahistoria_[A-Za-z0-9-]+_[A-Za-z0-9-]+$/;

function getFormValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function isShopCredentialsRecord(
  value: unknown,
): value is ShopCredentialsRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      "shopId" in value &&
      typeof value.shopId === "string" &&
      "apiKey" in value &&
      typeof value.apiKey === "string" &&
      "updatedAt" in value &&
      typeof value.updatedAt === "string",
  );
}

export function getShopCredentialsStorageKey(shop: string) {
  return `${SHOP_CREDENTIALS_KEY_PREFIX}${shop.toLowerCase()}`;
}

export function isValidShopId(value: string) {
  return UUID_PATTERN.test(value);
}

export function isValidAuraHistoriaApiKey(value: string) {
  return API_KEY_PATTERN.test(value);
}

export function validateShopCredentialsFormData(
  formData: FormData,
): ShopCredentialsValidationResult {
  const values = {
    shopId: getFormValue(formData.get("shopId")),
    apiKey: getFormValue(formData.get("apiKey")),
  };
  const errors: ShopCredentialsErrors = {};

  if (!values.shopId) {
    errors.shopId = "Please enter your Aura Historia shop ID";
  } else if (!isValidShopId(values.shopId)) {
    errors.shopId = "Please enter a valid UUID shop ID";
  }

  if (!values.apiKey) {
    errors.apiKey = "Please enter your Aura Historia API key";
  } else if (!isValidAuraHistoriaApiKey(values.apiKey)) {
    errors.apiKey = "Use the format aurahistoria_[short key]_[long key]";
  }

  return {
    errors,
    isValid: Object.keys(errors).length === 0,
    values,
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
    updatedAt: new Date().toISOString(),
  };

  await kv.put(getShopCredentialsStorageKey(shop), JSON.stringify(record));

  return record;
}
