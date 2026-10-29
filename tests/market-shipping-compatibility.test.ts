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

// The upgrade guide's audit lists the merchant-owned delivery profile
// operations. Shopify deprecated them for market-driven shops: reads can
// return a stale snapshot and writes no longer change live shipping.
const MERCHANT_PROFILE_API = /\bdeliveryProfile\w*/;

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
    assert.ok(queries.some((query) => /delivery\s*\{\s*shipping/.test(query)));
    for (const query of queries)
      assert.doesNotMatch(query, MERCHANT_PROFILE_API);
  });

  it("keeps reading legacy shops from their delivery profiles", async () => {
    const queries = await sentQueries(fixtureGraphql().request);
    assert.ok(queries.some((query) => /\bdeliveryProfiles\(/.test(query)));
    for (const query of queries) assert.doesNotMatch(query, /\bmarkets?\(/);
  });

  // Shipping, market and delivery settings stay the merchant's. A new
  // mutation needs a review of the compatibility record in the README.
  it("sends no GraphQL mutation besides the channel connection and bulk export", () => {
    const mutations = sources.flatMap(({ text }) =>
      [...text.matchAll(/\bmutation\s*(\w*)\s*[({]/g)].map(([, name]) => name),
    );
    assert.deepEqual(mutations.sort(), [
      "AuraChannelCreate",
      "AuraChannelUpdate",
      "BulkOperationRunQuery",
    ]);
  });

  it("references merchant delivery profile APIs only in the shipping acquisition", () => {
    assert.deepEqual(
      sources
        .filter(({ text }) => MERCHANT_PROFILE_API.test(text))
        .map(({ path }) => path),
      [join("app", "shipping", "acquisition.server.ts")],
    );
  });
});
