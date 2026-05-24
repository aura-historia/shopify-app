import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const appIndexRoute = readFileSync(
  resolve(process.cwd(), "app/routes/app._index.tsx"),
  "utf8",
);

describe("embedded app page", () => {
  it("focuses on credentials, support links, and direct contact info", () => {
    assert.ok(appIndexRoute.includes("Aura Historia backend credentials"));
    assert.ok(appIndexRoute.includes("Support and policies"));
    assert.match(appIndexRoute, /href: "https:\/\/aura-historia\.com"/);
    assert.match(
      appIndexRoute,
      /href: "https:\/\/aura-historia\.com\/privacy"/,
    );
    assert.match(
      appIndexRoute,
      /href: "https:\/\/aura-historia\.com\/terms-and-conditions"/,
    );
    assert.ok(appIndexRoute.includes("contact@aura-historia.com"));
  });

  it("removes the previous product, compliance, and scope-heavy content", () => {
    assert.doesNotMatch(appIndexRoute, /Granted scope/);
    assert.doesNotMatch(appIndexRoute, /products\/create/);
    assert.doesNotMatch(appIndexRoute, /customers\/data_request/);
  });
});
