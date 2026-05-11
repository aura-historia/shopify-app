import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
};

describe("tooling configuration", () => {
  it("uses localhost mode for the default dev command", () => {
    assert.equal(packageJson.scripts.dev, "shopify app dev --use-localhost");
  });

  it("keeps a tunnel-based dev command for direct webhook testing", () => {
    assert.equal(packageJson.scripts["dev:tunnel"], "shopify app dev");
  });

  it("uses biome for linting", () => {
    assert.equal(
      packageJson.scripts.lint,
      "biome check --files-ignore-unknown=true .",
    );
  });
});
