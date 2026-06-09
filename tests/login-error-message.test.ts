import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";
import { loginErrorMessage } from "../app/routes/auth.login/error.server";

describe("loginErrorMessage", () => {
  it("returns no message when there is no login error", () => {
    assert.deepEqual(loginErrorMessage({}), {});
  });

  it("maps a missing shop to a Shopify-owned install guidance message", () => {
    assert.deepEqual(loginErrorMessage({ shop: LoginErrorType.MissingShop }), {
      shop: "Start installation from Shopify so the store context is included.",
    });
  });

  it("maps an invalid shop to a Shopify-owned install guidance message", () => {
    assert.deepEqual(loginErrorMessage({ shop: LoginErrorType.InvalidShop }), {
      shop: "Shopify sent an invalid store context. Reopen the app from Shopify Admin or the App Store.",
    });
  });
});
