import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const marketingRoute = readFileSync(
  resolve(process.cwd(), "app/routes/_index/route.tsx"),
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

describe("public install flow", () => {
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

  it("redirects the auth callback to the success page", () => {
    assert.match(authRoute, /\/success\?\$\{successParams\.toString\(\)\}/);
    assert.ok(authRoute.includes('target: "_parent"'));
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
});
