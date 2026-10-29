import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { GraphqlRequestFn } from "../app/backfill.server";
import {
  acquireShippingStep,
  beginAcquisition,
} from "../app/shipping/acquisition.server";
import {
  fixture,
  fixtureGraphql,
  marketGraphql,
} from "./helpers/shipping-fixtures";

// Shopify's upgrade guide asks apps to audit these merchant-owned delivery
// profile APIs before attesting market-driven shipping compatibility. For
// market-driven shops their reads can return a stale snapshot, and their
// writes no longer change the merchant's live shipping settings.
const MERCHANT_PROFILE_API = /\bdeliveryProfile\w*/;
const SHIPPING_WRITE =
  /\b(?:deliveryProfile(?:Create|Update|Remove)|market(?:Create|Update|Delete))\b/;

async function sentQueries(request: GraphqlRequestFn) {
  const queries: string[] = [];
  const state = beginAcquisition(fixture.acquiredAt);
  while (state.tasks.length)
    await acquireShippingStep(state, (query, variables) => {
      queries.push(query);
      return request(query, variables);
    });
  return queries;
}

function sourceFiles(directory: string) {
  return readdirSync(directory, { encoding: "utf8", recursive: true })
    .filter((path) => /\.tsx?$/.test(path))
    .map((path) => join(directory, path))
    .filter((path) => !path.startsWith(join("app", "generated")));
}

const sources = ["app", "workers"].flatMap(sourceFiles).map((path) => ({
  path,
  text: readFileSync(path, "utf8"),
}));

describe("market-driven shipping compatibility", () => {
  it("reads market-driven shops through Markets without merchant delivery profile APIs", async () => {
    const queries = await sentQueries(marketGraphql().request);
    assert.ok(queries.some((query) => /\bdelivery \{ shipping\b/.test(query)));
    for (const query of queries)
      assert.doesNotMatch(query, MERCHANT_PROFILE_API);
  });

  it("keeps reading legacy shops from their delivery profiles", async () => {
    const queries = await sentQueries(fixtureGraphql().request);
    assert.ok(queries.some((query) => /\bdeliveryProfiles\(/.test(query)));
    for (const query of queries) assert.doesNotMatch(query, /\bmarkets?\(/);
  });

  it("never writes merchant delivery profiles or markets", () => {
    assert.ok(sources.length > 0);
    for (const { path, text } of sources)
      assert.doesNotMatch(text, SHIPPING_WRITE, path);
  });

  it("confines merchant delivery profile reads to the legacy acquisition", () => {
    assert.deepEqual(
      sources
        .filter(({ text }) => MERCHANT_PROFILE_API.test(text))
        .map(({ path }) => path),
      [join("app", "shipping", "acquisition.server.ts")],
    );
  });
});
