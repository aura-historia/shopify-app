import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const deployWorkflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/deploy.yml"),
  "utf8",
);

describe("deploy workflow", () => {
  it("runs on semver-like tags and validates the tag format", () => {
    assert.match(deployWorkflow, /tags:\s+- "\*\.\*\.\*"/);
    assert.match(
      deployWorkflow,
      /\[\[ ! "\$\{GITHUB_REF_NAME\}" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/,
    );
  });

  it("installs dependencies and runs the standard quality checks", () => {
    assert.match(deployWorkflow, /uses: actions\/setup-node@v6/);
    assert.match(deployWorkflow, /run: npm ci/);
    assert.match(deployWorkflow, /npm run lint/);
    assert.match(deployWorkflow, /npm run typecheck/);
    assert.match(deployWorkflow, /npm run test/);
    assert.match(deployWorkflow, /npm run build/);
  });

  it("deploys the Cloudflare worker with CI secrets", () => {
    assert.match(deployWorkflow, /run: npx wrangler deploy/);
    assert.match(
      deployWorkflow,
      /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/,
    );
    assert.match(
      deployWorkflow,
      /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/,
    );
  });

  it("deploys and releases the production Shopify app with the tag version", () => {
    assert.match(
      deployWorkflow,
      /SHOPIFY_APP_AUTOMATION_TOKEN: \$\{\{ secrets\.SHOPIFY_APP_AUTOMATION_TOKEN \}\}/,
    );
    assert.match(deployWorkflow, /app deploy/);
    assert.match(deployWorkflow, /--config=prod/);
    assert.match(deployWorkflow, /--allow-updates/);
    assert.match(deployWorkflow, /--no-release/);
    assert.match(deployWorkflow, /--version="\$\{GITHUB_REF_NAME\}"/);
    assert.match(
      deployWorkflow,
      /--source-control-url="\$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/commit\/\$\{GITHUB_SHA\}"/,
    );
    assert.match(deployWorkflow, /app release/);
  });
});
