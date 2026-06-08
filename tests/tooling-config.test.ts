import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
  engines: Record<string, string>;
};

describe("tooling configuration", () => {
  it("keeps the Node engine compatible with current Shopify tooling", () => {
    assert.equal(packageJson.engines.node, ">=20.19 <22 || >=22.12");
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
});
