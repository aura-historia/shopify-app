import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearInstallCredentialsCookie,
  getInstallCredentialsFromSearchParams,
  getPathWithSearchParams,
  hasInstallCredentialsSearchParams,
  readInstallCredentialsCookie,
  serializeInstallCredentialsCookie,
  stripInstallCredentialsSearchParams,
} from "../app/install-credentials.server";

describe("install credentials handling", () => {
  it("trims install credentials from query params", () => {
    const searchParams = new URLSearchParams({
      apiKey: " aurahistoria_partner_abcdef123456 ",
      shopId: " 123e4567-e89b-12d3-a456-426614174000 ",
    });

    assert.deepEqual(getInstallCredentialsFromSearchParams(searchParams), {
      apiKey: "aurahistoria_partner_abcdef123456",
      shopId: "123e4567-e89b-12d3-a456-426614174000",
    });
    assert.equal(hasInstallCredentialsSearchParams(searchParams), true);
  });

  it("strips install credentials while preserving Shopify context params", () => {
    const searchParams = new URLSearchParams({
      apiKey: "aurahistoria_partner_abcdef123456",
      host: "host-token",
      shop: "example.myshopify.com",
      shopId: "123e4567-e89b-12d3-a456-426614174000",
    });

    const strippedSearchParams =
      stripInstallCredentialsSearchParams(searchParams);

    assert.equal(
      getPathWithSearchParams("/app", strippedSearchParams),
      "/app?host=host-token&shop=example.myshopify.com",
    );
    assert.equal(strippedSearchParams.has("apiKey"), false);
    assert.equal(strippedSearchParams.has("shopId"), false);
  });

  it("round-trips install credentials through the short-lived cookie for the embedded app", async () => {
    const setCookieHeader = await serializeInstallCredentialsCookie({
      apiKey: "aurahistoria_partner_abcdef123456",
      shopId: "123e4567-e89b-12d3-a456-426614174000",
    });
    const cookieHeader = setCookieHeader.split(";", 1)[0];

    const parsedCookie = await readInstallCredentialsCookie(cookieHeader);

    assert.deepEqual(parsedCookie, {
      apiKey: "aurahistoria_partner_abcdef123456",
      shopId: "123e4567-e89b-12d3-a456-426614174000",
    });
    assert.match(setCookieHeader, /HttpOnly/);
    assert.match(setCookieHeader, /Max-Age=600/);
    assert.match(setCookieHeader, /SameSite=None/);
    assert.match(setCookieHeader, /Secure/);
  });

  it("clears the install credentials cookie after the app consumes it", async () => {
    const cookieHeader = await clearInstallCredentialsCookie();

    assert.match(cookieHeader, /Max-Age=0/);
  });
});
