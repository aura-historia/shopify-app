import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";
import { loginErrorMessage } from "../app/routes/auth.login/error.server";

describe("loginErrorMessage", () => {
  it("returns no message when there is no login error", () => {
    assert.deepEqual(loginErrorMessage({}), {});
  });

  it("maps a missing shop to a helpful message", () => {
    assert.deepEqual(loginErrorMessage({ shop: LoginErrorType.MissingShop }), {
      shop: "Please enter your shop domain to continue",
    });
  });

  it("maps an invalid shop to a helpful message", () => {
    assert.deepEqual(loginErrorMessage({ shop: LoginErrorType.InvalidShop }), {
      shop: "Please enter a valid shop domain to continue",
    });
  });
});
