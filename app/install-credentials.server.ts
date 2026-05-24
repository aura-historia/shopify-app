import { createCookie } from "react-router";
import type { ShopCredentialsValues } from "./shop-credentials.server";

export interface InstallCredentialsValues extends ShopCredentialsValues {}

const installCredentialsCookie = createCookie(
  "__aura_historia_install_credentials",
  {
    httpOnly: true,
    maxAge: 60 * 10,
    path: "/",
    sameSite: "lax",
    secure: true,
  },
);

function trimSearchParamValue(value: string | null) {
  return typeof value === "string" ? value.trim() : "";
}

function isInstallCredentialsValues(
  value: unknown,
): value is InstallCredentialsValues {
  return Boolean(
    value &&
      typeof value === "object" &&
      "apiKey" in value &&
      typeof value.apiKey === "string" &&
      "shopId" in value &&
      typeof value.shopId === "string",
  );
}

export function getInstallCredentialsFromSearchParams(
  searchParams: URLSearchParams,
): InstallCredentialsValues | null {
  const values = {
    apiKey: trimSearchParamValue(searchParams.get("apiKey")),
    shopId: trimSearchParamValue(searchParams.get("shopId")),
  };

  return values.apiKey || values.shopId ? values : null;
}

export function hasInstallCredentialsSearchParams(
  searchParams: URLSearchParams,
) {
  return searchParams.has("apiKey") || searchParams.has("shopId");
}

export function stripInstallCredentialsSearchParams(
  searchParams: URLSearchParams,
) {
  const nextSearchParams = new URLSearchParams(searchParams);
  nextSearchParams.delete("apiKey");
  nextSearchParams.delete("shopId");
  return nextSearchParams;
}

export function getPathWithSearchParams(
  pathname: string,
  searchParams: URLSearchParams,
) {
  const search = searchParams.toString();
  return search ? `${pathname}?${search}` : pathname;
}

export async function readInstallCredentialsCookie(
  cookieHeader: string | null,
): Promise<InstallCredentialsValues | null> {
  const parsedValue = await installCredentialsCookie.parse(cookieHeader);
  return isInstallCredentialsValues(parsedValue) ? parsedValue : null;
}

export async function serializeInstallCredentialsCookie(
  values: InstallCredentialsValues,
) {
  return installCredentialsCookie.serialize(values);
}

export async function clearInstallCredentialsCookie() {
  return installCredentialsCookie.serialize("", { maxAge: 0 });
}
