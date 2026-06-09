import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const rootDocument = readFileSync(
  resolve(process.cwd(), "app/root.tsx"),
  "utf8",
);
const appShellRoute = readFileSync(
  resolve(process.cwd(), "app/routes/app.tsx"),
  "utf8",
);
const marketingRoute = readFileSync(
  resolve(process.cwd(), "app/routes/_index/route.tsx"),
  "utf8",
);
const authLoginRoute = readFileSync(
  resolve(process.cwd(), "app/routes/auth.login/route.tsx"),
  "utf8",
);
const authRoute = readFileSync(
  resolve(process.cwd(), "app/routes/auth.$.tsx"),
  "utf8",
);
const successRoute = readFileSync(
  resolve(process.cwd(), "app/routes/success.tsx"),
  "utf8",
);
const appIndexRoute = readFileSync(
  resolve(process.cwd(), "app/routes/app._index.tsx"),
  "utf8",
);

describe("public install flow", () => {
  it("uses Shopify AppProvider for embedded App Bridge boot", () => {
    assert.equal(rootDocument.includes("shopifycloud/app-bridge.js"), false);
    assert.ok(appShellRoute.includes("AppProvider"));
    assert.ok(appShellRoute.includes("embedded apiKey={apiKey}"));
  });

  it("routes a shop-only App Store link directly to the login handler", () => {
    // App Store install links carry only ?shop= (no host param).
    // We must hand off to shopify.login(), which drives the OAuth install
    // redirect without requiring a host param.
    // Routing through /app or /auth first breaks because authenticate.admin()
    // requires both shop AND host and falls back to a blank login page.
    assert.match(
      marketingRoute,
      /\/auth\/login\?\$\{url\.searchParams\.toString\(\)\}/,
    );
  });

  it("routes an embedded admin launch (has host) to the app shell", () => {
    // Shopify admin always includes `host` when opening the app in the
    // embedded iframe. Those requests must reach /app so authenticate.admin()
    // can do the token exchange instead of triggering a login() OAuth
    // redirect inside the iframe (which breaks framing).
    assert.match(marketingRoute, /url\.searchParams\.get\(["']host["']\)/);
    assert.match(
      marketingRoute,
      /\/app\?\$\{url\.searchParams\.toString\(\)\}/,
    );
  });

  it("starts Aura Historia OAuth after the Shopify auth callback", () => {
    assert.ok(authRoute.includes("buildAuraHistoriaOAuthAuthorizeUrl"));
    assert.match(authRoute, /authorization\.url\.toString\(\)/);
    assert.ok(authRoute.includes('target: "_parent"'));
    assert.ok(authRoute.includes('integration", "oauth-config-missing"'));
  });

  it("keeps review links and contact details on the success page", () => {
    assert.ok(successRoute.includes("https://aura-historia.com"));
    assert.ok(successRoute.includes("https://aura-historia.com/privacy"));
    assert.ok(successRoute.includes("https://aura-historia.com/imprint"));
    assert.ok(
      successRoute.includes("https://aura-historia.com/terms-and-conditions"),
    );
    assert.ok(successRoute.includes("contact@aura-historia.com"));
  });

  it("does not request manual shop-domain entry on public pages", () => {
    assert.equal(marketingRoute.includes('name="shop"'), false);
    assert.equal(authLoginRoute.includes('name="shop"'), false);
    assert.equal(marketingRoute.includes("Continue with store domain"), false);
    assert.equal(
      authLoginRoute.includes("Continue to Shopify approval"),
      false,
    );
    assert.ok(marketingRoute.includes("Installation starts in Shopify"));
    assert.ok(authLoginRoute.includes("Start installation from Shopify"));
  });

  it("keeps the public and embedded home routes focused on support and access details", () => {
    assert.ok(
      marketingRoute.includes("https://aura-historia.com/partners/shopify"),
    );
    assert.ok(marketingRoute.includes("products/create"));
    assert.ok(marketingRoute.includes("customers/data_request"));
    assert.ok(marketingRoute.includes("read_locales"));
    assert.ok(appIndexRoute.includes("https://aura-historia.com"));
    assert.ok(
      appIndexRoute.includes("https://aura-historia.com/partners/shopify"),
    );
    assert.ok(appIndexRoute.includes("contact@aura-historia.com"));
    assert.ok(appIndexRoute.includes("products/update"));
    assert.ok(appIndexRoute.includes("app/uninstalled"));
    assert.ok(appIndexRoute.includes("read_locales"));
    assert.ok(appIndexRoute.includes("Connected via OAuth"));
    assert.ok(appIndexRoute.includes('"disconnected"'));
    assert.ok(appIndexRoute.includes("isShopCredentialsDisconnected"));
    assert.ok(appIndexRoute.includes("markShopCredentialsDisconnected"));
    assert.ok(
      appIndexRoute.includes('redirectParams.set("disconnect", "success")'),
    );
    assert.ok(
      appIndexRoute.includes(
        "Failed to revoke Aura Historia access on disconnect",
      ),
    );
    assert.ok(appIndexRoute.includes("Reconnect Aura Historia"));
    assert.ok(appIndexRoute.includes("Retry Aura Historia connection"));
    assert.ok(appIndexRoute.includes("Disconnect Aura Historia"));
    assert.ok(appIndexRoute.includes('name="intent" value="disconnect"'));
    assert.ok(appIndexRoute.includes("manual_connect"));
    assert.ok(appIndexRoute.includes("Secure token stored"));
    assert.equal(appIndexRoute.includes("accessTokenPreview"), false);
    assert.ok(appIndexRoute.includes("secondaryButton"));
  });
});
