import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const ciWorkflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/ci.yml"),
  "utf8",
);

describe("CI workflow", () => {
  it("runs lint, typecheck, test, and build", () => {
    assert.match(ciWorkflow, /- lint/);
    assert.match(ciWorkflow, /- typecheck/);
    assert.match(ciWorkflow, /- test/);
    assert.match(ciWorkflow, /- build/);
  });

  it("runs supported Node versions from the package engine", () => {
    assert.match(ciWorkflow, /- 20\.19\.0/);
    assert.match(ciWorkflow, /- 22\.12\.0/);
  });

  it("installs dependencies with npm ci", () => {
    assert.match(ciWorkflow, /run: npm ci/);
  });
});
