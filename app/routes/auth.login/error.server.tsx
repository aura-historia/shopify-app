import type { LoginError } from "@shopify/shopify-app-react-router/server";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

interface LoginErrorMessage {
  shop?: string;
}

export function loginErrorMessage(loginErrors: LoginError): LoginErrorMessage {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return {
      shop: "Start installation from Shopify so the store context is included.",
    };
  }

  if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return {
      shop: "Shopify sent an invalid store context. Reopen the app from Shopify Admin or the App Store.",
    };
  }

  return {};
}
