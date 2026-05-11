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
  it("prefers Shopify-provided query context when available", () => {
    assert.ok(
      marketingRoute.includes("/auth/login?${url.searchParams.toString()}"),
    );
  });

  it("redirects the auth callback to the success page", () => {
    assert.ok(authRoute.includes("/success?${successParams.toString()}"));
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
