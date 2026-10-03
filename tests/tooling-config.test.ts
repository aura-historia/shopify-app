import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
  engines: Record<string, string>;
  dependencies: Record<string, string>;
};

describe("tooling configuration", () => {
  it("keeps the Node engine compatible with current Shopify tooling", () => {
    assert.equal(packageJson.engines.node, ">=22.18");
  });

  it("uses localhost mode for the default dev command", () => {
    assert.equal(packageJson.scripts.dev, "shopify app dev --use-localhost");
  });

  it("keeps a tunnel-based dev command for direct webhook testing", () => {
    assert.equal(
      packageJson.scripts["dev:tunnel"],
      "shopify app dev --config=tunnel",
    );
  });

  it("uses biome for linting", () => {
    assert.equal(
      packageJson.scripts.lint,
      "biome check --files-ignore-unknown=true .",
    );
  });

  it("keeps setup as a no-op because sessions use Cloudflare KV", () => {
    assert.equal(
      packageJson.scripts.setup,
      "node -e \"console.log('No setup required: Shopify sessions use Cloudflare KV.')\"",
    );
    assert.equal(packageJson.scripts["docker-start"], "npm run start");
  });

  it("keeps a production config selection script", () => {
    assert.equal(
      packageJson.scripts["config:use:prod"],
      "shopify app config use prod",
    );
  });

  it("keeps a production deploy script", () => {
    assert.equal(
      packageJson.scripts["deploy:prod"],
      "shopify app deploy --config=prod --allow-updates",
    );
  });

  it("pins generated API clients to the intended backend revision", () => {
    const config = readFileSync(
      resolve(process.cwd(), "openapi-ts.config.ts"),
      "utf8",
    );
    assert.equal(packageJson.scripts["openapi:generate"], "openapi-ts");
    assert.match(config, /792444f6d62cfb9f8dd4dc44ffb47a420de54cad/);
    assert.match(config, /output: "app\/generated\/api"/);
  });

  it("deploys the production API and OAuth environment with the Shopify capabilities", () => {
    const wrangler = readFileSync(
      resolve(process.cwd(), "wrangler.jsonc"),
      "utf8",
    );
    assert.match(
      wrangler,
      /"AURA_HISTORIA_API_BASE_URL": "https:\/\/api\.aura-historia\.com"/,
    );
    assert.match(wrangler, /"AURA_HISTORIA_OAUTH_ENV": "prod"/);
    assert.match(
      wrangler,
      /"AURA_HISTORIA_OAUTH_SCOPE": "listing-sources:write product-listings:write"/,
    );
    const clientId = wrangler.match(
      /"AURA_HISTORIA_OAUTH_CLIENT_ID": "([^"]+)"/,
    )?.[1];
    assert.ok(clientId);
    if (clientId === "oc_REPLACE_WITH_PRODUCTION_OAUTH_CLIENT_ID") {
      assert.match(
        wrangler,
        /PLACEHOLDER: replace with the registered production/,
      );
    } else {
      assert.match(clientId, /^oc_[0-7][0-9a-hjkmnp-tv-z]{25}$/);
    }
    assert.equal(packageJson.dependencies["node-html-markdown"], undefined);
  });
});
