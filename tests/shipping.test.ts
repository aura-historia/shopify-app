import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import Ajv from "ajv";
import type { GraphqlRequestFn } from "../app/backfill.server";
import type {
  CreateShippingProfileData,
  ProductListingDeliveryCommandData,
} from "../app/generated/api/types.gen";
import {
  acquireShippingStep,
  beginAcquisition,
} from "../app/shipping/acquisition.server";
import { exactMoney, mapShipping } from "../app/shipping/mapper";
import { profileObjectKey, SHIPPING_LIMITS } from "../app/shipping/model";
import {
  addConfirmedRemovals,
  beginPublication,
  beginWithdrawal,
  publishShippingStep,
} from "../app/shipping/publisher.server";
import {
  fixture,
  fixtureGraphql,
  importIdentityRejection,
} from "./helpers/shipping-fixtures";

const contract = JSON.parse(
  readFileSync(
    new URL("./fixtures/shipping-contract.json", import.meta.url),
    "utf8",
  ),
);
const contractSchemas = JSON.parse(
  readFileSync(
    new URL("./fixtures/shipping-openapi-schemas.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });

function matchesContract(schema: string, body: unknown) {
  const validate = ajv.compile({
    $ref: `#/components/schemas/${schema}`,
    components: contractSchemas.components,
  });
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
}
const source = "ls_01h455vb4pex5vy7enb1p677v1";
const profileId = "shp_01h455vb4pex5vy7enb1p677v3";
const context = {
  listingSourceId: source,
  accessToken: "test-aura-credential",
  apiBaseUrl: "https://aura.invalid",
};

async function acquire(request: GraphqlRequestFn) {
  const state = beginAcquisition(fixture.acquiredAt);
  while (state.tasks.length) {
    await acquireShippingStep(state, request);
    // Exercise checkpoint roundtrips between every bounded request.
    Object.assign(state, JSON.parse(JSON.stringify(state)));
    assert.ok(state.pages < 200);
  }
  return state.snapshot;
}

function publication() {
  return beginPublication(
    mapShipping(fixture),
    "run-1",
    1,
    fixture.acquiredAt,
    {},
  );
}

function auraMock(
  options: {
    loseCreate?: boolean;
    missingListing?: boolean;
    ownershipConflict?: boolean;
    profileOwned?: boolean;
    conflict?: boolean;
  } = {},
) {
  const calls: {
    path: string;
    method: string;
    body: Record<string, unknown> | null;
    raw: string;
  }[] = [];
  let created = false;
  let lost = false;
  const fetcher: typeof fetch = async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const raw = await request.text();
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ path: url.pathname, method: request.method, body, raw });
    const rejected = importIdentityRejection(
      request.method,
      url.pathname,
      body,
    );
    if (rejected) return rejected;
    if (
      request.method === "GET" &&
      url.pathname.endsWith("shipping-profiles")
    ) {
      return Response.json(
        created || options.profileOwned ? [contract.committedProfile] : [],
      );
    }
    if (
      request.method === "POST" &&
      url.pathname.endsWith("shipping-profiles")
    ) {
      created = true;
      if (options.loseCreate && !lost) {
        lost = true;
        throw new Error("lost response");
      }
      return Response.json(contract.committedProfile, { status: 201 });
    }
    if (
      options.profileOwned &&
      request.method === "PUT" &&
      url.pathname.includes("/shipping-profiles/")
    ) {
      return Response.json(
        { error: "SHIPPING_IMPORT_OWNERSHIP_CONFLICT" },
        { status: 409 },
      );
    }
    if (url.pathname.endsWith("shipping-default"))
      return Response.json({
        listingSourceId: source,
        revision: 1,
        shippingProfileId: request.method === "PUT" ? profileId : null,
        eligibility: null,
      });
    if (url.pathname.endsWith("delivery")) {
      if (options.missingListing)
        return Response.json(
          { error: "SHIPPING_IMPORT_DEPENDENCY_MISSING" },
          { status: 404 },
        );
      if (request.method === "GET")
        return Response.json({
          productListingId: "pl_test",
          expectedVersion: 1,
          delivery: null,
        });
      if (options.ownershipConflict || options.conflict)
        return Response.json(
          {
            error: options.ownershipConflict
              ? "SHIPPING_IMPORT_OWNERSHIP_CONFLICT"
              : "SHIPPING_IMPORT_AUTHORITY_STALE",
          },
          { status: 409 },
        );
      return Response.json(contract.committedMembership);
    }
    return Response.json(contract.committedProfile);
  };
  return { fetcher, calls, options };
}

async function finish(
  state: ReturnType<typeof publication>,
  mock: ReturnType<typeof auraMock>,
) {
  for (let i = 0; state.work.some((w) => !w.done) && !state.reconcile; i++) {
    assert.ok(i < 100);
    await publishShippingStep(
      state,
      context,
      Date.now() + 86_400_000,
      mock.fetcher,
    );
  }
}

describe("Shopify shipping acquisition and canonical mapping", () => {
  it("paginates profiles, items, assigned variants, product variants, zones and all legacy-expanded tiers", async () => {
    const mock = fixtureGraphql();
    const acquired = await acquire(mock.request);
    assert.deepEqual(mapShipping(acquired), mapShipping(fixture));
    for (const name of [
      "ShippingProfiles",
      "ShippingItems",
      "ShippingMembershipVariants",
      "ShippingVariants",
      "ShippingZones",
      "ShippingProducts",
    ]) {
      assert.ok(
        mock.calls.some(
          (call) =>
            call.name === name &&
            (call.variables.after || call.variables.zoneAfter),
        ),
        name,
      );
    }
    const mapped = mapShipping(acquired);
    assert.equal(mapped.profiles.length, 2);
    assert.equal(mapped.memberships[0].sourceListingId, "101");
    assert.equal(mapped.memberships[0].variants?.length, 2);
    assert.equal(mapped.memberships[1].profileObjectKey, null);
    const policy = mapped.profiles[0].content.terms.shipping;
    assert.equal(policy?.kind, "COVERAGE");
    if (policy?.kind !== "COVERAGE") return;
    const services = policy.coverage.zones[0].services;
    assert.equal(services.length, 4);
    assert.deepEqual(services[0].rate?.price, {
      kind: "FIXED",
      amount: { amount_minor: 750, currency: "EUR" },
    });
    assert.deepEqual(services[1].applicability.threshold, {
      minimum: { amount_minor: 5000, currency: "EUR" },
      scope: "SELLER_ORDER",
    });
    assert.equal(services[2].eligibility, null);
    assert.equal(services[2].rate, null);
    assert.equal(services[3].rate?.price.kind, "EXTERNALLY_CALCULATED");
  });

  it("rejects changed profiles/products, invalid cursors and incomplete pages", async () => {
    const mock = fixtureGraphql();
    const state = beginAcquisition(fixture.acquiredAt);
    await acquireShippingStep(state, mock.request);
    await acquireShippingStep(state, mock.request);
    mock.snapshot.profiles[Object.keys(mock.snapshot.profiles)[0]].version++;
    await assert.rejects(async () => {
      while (state.tasks.length) await acquireShippingStep(state, mock.request);
    }, /SHOPIFY_CHANGED_DURING_READ/);
    const incomplete = beginAcquisition(fixture.acquiredAt);
    incomplete.tasks = [{ kind: "products" }];
    await assert.rejects(
      acquireShippingStep(incomplete, async () => ({
        data: { products: { nodes: [] } },
      })),
      /INCOMPLETE_SHOPIFY_PAGE/,
    );
  });

  it("reports permission, incompatible schema and market-driven capability gaps before acquiring profiles", async () => {
    for (const [scope, market, fields, expected] of [
      ["read_assigned_shipping", false, true, "SHIPPING_PERMISSION_REQUIRED"],
      ["read_shipping", true, true, "MARKET_DRIVEN_SHIPPING_UNSUPPORTED"],
      ["read_shipping", false, false, "UNSUPPORTED_SHOPIFY_SCHEMA"],
    ] as const) {
      const state = beginAcquisition(fixture.acquiredAt);
      await assert.rejects(
        acquireShippingStep(state, async () => ({
          data: {
            currentAppInstallation: { accessScopes: [{ handle: scope }] },
            shop: { features: { marketDrivenShipping: market } },
            method: {
              fields: fields
                ? [{ name: "rateProvider" }, { name: "methodConditions" }]
                : [],
            },
          },
        })),
        new RegExp(expected),
      );
    }
  });

  it("rejects duplicate final profile pages instead of counting a missing profile as verified", async () => {
    const state = beginAcquisition(fixture.acquiredAt);
    const mock = fixtureGraphql();
    while (!state.verifying) await acquireShippingStep(state, mock.request);
    const first = Object.values(fixture.profiles)[0];
    const repeated: GraphqlRequestFn = async (query, variables) =>
      query.includes("ShippingProfiles")
        ? {
            data: {
              deliveryProfiles: {
                nodes: [first],
                pageInfo: {
                  hasNextPage: !variables.after,
                  endCursor: variables.after ? "2" : "1",
                },
              },
            },
          }
        : mock.request(query, variables);
    await assert.rejects(async () => {
      while (state.tasks.length) await acquireShippingStep(state, repeated);
    }, /SHOPIFY_CHANGED_DURING_READ/);
  });

  it("uses exact minor units and refuses unsupported precision, currencies and unsafe integers", () => {
    assert.deepEqual(
      exactMoney({ amount: "90071992547409.91", currencyCode: "EUR" }),
      { amount_minor: Number.MAX_SAFE_INTEGER, currency: "EUR" },
    );
    assert.equal(
      exactMoney({ amount: "17.000", currencyCode: "JPY" }).amount_minor,
      17,
    );
    for (const money of [
      { amount: "0.001", currencyCode: "EUR" },
      { amount: "1.1", currencyCode: "JPY" },
      { amount: "90071992547409.92", currencyCode: "EUR" },
      { amount: "1", currencyCode: "XXX" },
    ]) {
      assert.throws(() => exactMoney(money));
    }
  });

  it("never invents default membership, geographic coverage, origin routing or overrides", () => {
    const unknown = structuredClone(fixture);
    unknown.profiles[Object.keys(unknown.profiles)[0]].memberships = {};
    assert.equal(mapShipping(unknown).memberships[0].profileObjectKey, null);
    const unsupported = structuredClone(fixture);
    const profile = unsupported.profiles[Object.keys(unsupported.profiles)[0]];
    profile.groups.push({ id: "another-origin", zones: [] });
    assert.equal(mapShipping(unsupported).profiles.length, 1);
    assert.equal(
      mapShipping(unsupported).memberships[0].profileObjectKey,
      null,
    );
    const worldwide = structuredClone(fixture);
    worldwide.profiles[profile.id].groups[0].zones[0].countries[0].code = {
      restOfWorld: true,
      countryCode: null,
    };
    const policy = mapShipping(worldwide).profiles[0].content.terms.shipping;
    assert.ok(policy?.kind === "COVERAGE");
    assert.equal(policy.coverage.zones[0].areas[0].kind, "UNRESOLVED");
    assert.equal(policy.coverage.completeness, "PARTIAL");
    assert.equal(policy.coverage.dispatch_origin, null);
  });

  it("limits a coversAllItems profile to known shippable variants", async () => {
    const mock = fixtureGraphql();
    const profile = Object.values(mock.snapshot.profiles)[0];
    profile.coversAllItems = true;
    const products = Object.values(mock.snapshot.products);
    products[0].shippableVariants = [...products[0].variants];
    // A mixed physical/digital product cannot select a universal policy.
    products[1].shippableVariants = products[1].variants.slice(0, 1);
    const mapping = mapShipping(await acquire(mock.request));
    assert.equal(
      mapping.memberships[0].profileObjectKey,
      profileObjectKey(profile.id),
    );
    assert.equal(mapping.memberships[1].profileObjectKey, null);
    delete products[0].shippableVariants;
    assert.equal(
      mapShipping(mock.snapshot).memberships[0].profileObjectKey,
      null,
    );
    profile.coversAllItems = false;
    profile.memberships = {};
    products[0].shippableVariants = [...products[0].variants];
    assert.equal(
      mapShipping(mock.snapshot).memberships[0].profileObjectKey,
      null,
    );
  });
});

describe("typed shipping publication", () => {
  it("requires a valid empty profile list before forgetting an ambiguous create during cleanup", async () => {
    const objectKey = "shopify:delivery-profile:1";
    for (const response of [
      () => Response.json({}),
      () => Response.json(null),
      () => Response.json([{}]),
      () => Response.json([], { status: 202 }),
      () => new Response(null, { status: 204 }),
    ]) {
      const state = beginWithdrawal(
        {
          [objectKey]: {
            id: "",
            providerId: "gid://shopify/DeliveryProfile/1",
          },
        },
        [],
        "cleanup",
        90,
        fixture.acquiredAt,
      );
      state.work = state.work.filter((work) => work.resource.kind === "retire");
      await publishShippingStep(state, context, 0, async () => response());
      assert.equal(state.work[0].done, undefined);
      assert.ok(state.mappings[objectKey]);
      assert.equal(state.lastError, "AURA_RESPONSE_INVALID");
      await publishShippingStep(state, context, 60_000, async () =>
        Response.json([]),
      );
      assert.equal(state.work[0].done, true);
      assert.equal(state.mappings[objectKey], undefined);
    }
  });

  it("uses contract-valid owned withdrawals without observing or clearing manual overrides", async () => {
    const state = beginWithdrawal(
      {
        "shopify:delivery-profile:1": {
          id: profileId,
          providerId: "gid://shopify/DeliveryProfile/1",
        },
      },
      ["101"],
      "withdrawal",
      90,
      fixture.acquiredAt,
    );
    const mock = auraMock();
    await finish(state, mock);
    const writes = mock.calls.filter((call) => call.body);
    assert.equal(writes.length, 4);
    for (const write of writes) {
      const schema = write.path.endsWith("delivery")
        ? "ProductListingDeliveryCommandData"
        : write.path.endsWith("shipping-default")
          ? "ClearShippingDefaultData"
          : "ShippingProfileLifecycleData";
      matchesContract(schema, write.body);
      assert.doesNotMatch(write.raw, /"observation"/);
      if (write.path.endsWith("delivery")) {
        assert.match(write.raw, /"shipping":\{"state":"UNCHANGED"\}/);
        assert.match(write.raw, /"collection":\{"state":"UNCHANGED"\}/);
      }
    }
  });
  it("bounds repeated identity conflicts when collection reads cannot resolve the profile", async () => {
    const state = publication();
    state.work = state.work.slice(0, 1);
    const unresolved: typeof fetch = async (input) =>
      (input as Request).method === "GET"
        ? Response.json([])
        : Response.json(
            { error: "SHIPPING_IMPORT_IDENTITY_EXISTS" },
            { status: 409 },
          );
    for (let i = 0; i < SHIPPING_LIMITS.retries * 2; i++)
      await publishShippingStep(state, context, i * 3600_000, unresolved);
    assert.equal(state.work[0].exhausted, true);
    assert.equal(state.committed, 0);
    assert.equal(state.reconcile, false);
  });

  it("retains exact requests for empty or structurally invalid success responses", async () => {
    for (const response of [
      () => Response.json({}),
      () => Response.json({ shippingProfileId: profileId }),
      () => new Response(null, { status: 204 }),
    ]) {
      const state = publication();
      const mock = auraMock();
      await publishShippingStep(state, context, 0, mock.fetcher);
      const pending = structuredClone(state.work[0].pending);
      await publishShippingStep(state, context, 0, async () => response());
      assert.deepEqual(state.work[0].pending, pending);
      assert.equal(state.work[0].done, undefined);
      assert.equal(state.committed, 0);
      assert.equal(state.lastError, "AURA_RESPONSE_INVALID");
      await publishShippingStep(state, context, 60_000, mock.fetcher);
      assert.equal(state.work[0].done, true);
    }
  });

  it("bounds record retries while preserving pending identity and independent progress", async () => {
    const state = publication();
    const mock = auraMock();
    await publishShippingStep(state, context, 0, mock.fetcher);
    const pending = structuredClone(state.work[0].pending);
    const fail: typeof fetch = async () =>
      Response.json(
        { error: "private provider diagnostics including a credential" },
        { status: 503 },
      );
    for (let i = 0; i < SHIPPING_LIMITS.retries; i++) {
      await publishShippingStep(state, context, i * 3600_000, fail);
    }
    assert.equal(state.work[0].exhausted, true);
    assert.equal(state.work[0].done, undefined);
    assert.deepEqual(state.work[0].pending, pending);
    assert.equal(state.lastError, "AURA_HTTP_503");
    for (let i = 0; i < 10; i++)
      await publishShippingStep(state, context, 86_400_000, mock.fetcher);
    assert.ok(state.committed > 0);
    assert.equal(state.work[0].attempts, SHIPPING_LIMITS.retries);
    assert.doesNotMatch(JSON.stringify(state), /private provider diagnostics/);
  });

  it("restores the stable retired identity before replacing it with a later sequence", async () => {
    const state = publication();
    const writes: { path: string; body: Record<string, unknown> }[] = [];
    let restored = false;
    const fetcher: typeof fetch = async (input) => {
      const request = input as Request;
      const url = new URL(request.url);
      const current = {
        ...contract.committedProfile,
        lifecycle: restored ? "ACTIVE" : "RETIRED",
        managementRevision: restored ? 2 : 1,
      };
      if (request.method === "GET") return Response.json([current]);
      writes.push({ path: url.pathname, body: await request.json() });
      restored = true;
      return Response.json({
        ...current,
        lifecycle: "ACTIVE",
        managementRevision: 2,
      });
    };
    for (let step = 0; step < 4; step++)
      await publishShippingStep(state, context, Date.now(), fetcher);
    assert.equal(writes.length, 2);
    assert.ok(writes[0].path.endsWith("/restore"));
    matchesContract("ShippingProfileLifecycleData", writes[0].body);
    matchesContract("ReplaceShippingProfileData", writes[1].body);
    const lifecycle = writes[0].body.import as {
      sequence: number;
      observation?: unknown;
    };
    const replacement = writes[1].body.import as { sequence: number };
    assert.equal(lifecycle.observation, undefined);
    assert.ok(lifecycle.sequence < replacement.sequence);
    assert.equal(writes[1].body.expectedRevision, 2);
    assert.equal(state.mappings[state.work[0].key].id, profileId);
  });

  it("publishes real mapper output before listing assignments using the merged contract metadata", async () => {
    const state = publication();
    const mock = auraMock();
    await finish(state, mock);
    const writes = mock.calls.filter((call) => call.method !== "GET");
    matchesContract("CreateShippingProfileData", contract.providerCreate);
    for (const write of writes)
      matchesContract(
        write.method === "POST"
          ? "CreateShippingProfileData"
          : write.method === "PATCH"
            ? "ProductListingDeliveryCommandData"
            : write.path.endsWith("shipping-default")
              ? "AssignShippingDefaultData"
              : "ReplaceShippingProfileData",
        write.body,
      );
    const create = writes.find((call) => call.method === "POST");
    assert.ok(create);
    const body = create.body as CreateShippingProfileData;
    assert.deepEqual(
      Object.keys(body).sort(),
      Object.keys(contract.providerCreate).sort(),
    );
    assert.deepEqual(
      Object.keys(body.import ?? {}).sort(),
      Object.keys(contract.providerCreate.import).sort(),
    );
    assert.deepEqual(body.import?.observation, {});
    assert.equal(body.import?.acquiredAt, fixture.acquiredAt);
    assert.deepEqual(
      body.import?.integration,
      contract.providerCreate.import.integration,
    );
    assert.equal(
      body.import?.objectKey,
      profileObjectKey(Object.keys(fixture.profiles)[0]),
    );
    const assignments = writes.filter((call) => call.method === "PATCH");
    assert.equal(assignments.length, 2);
    const mixed = assignments.find((call) => call.path.includes("/102/"))
      ?.body as ProductListingDeliveryCommandData;
    assert.ok(mixed.delivery.state === "SET");
    assert.deepEqual(mixed.delivery.value.selection, {
      state: "SET",
      value: { kind: "SUPPRESS_INHERITANCE" },
    });
    assert.deepEqual(mixed.delivery.value.shipping, { state: "UNCHANGED" });
    assert.deepEqual(mixed.delivery.value.collection, { state: "UNCHANGED" });
    assert.ok(writes.indexOf(create) < writes.indexOf(assignments[0]));
    assert.doesNotMatch(
      JSON.stringify(writes),
      /freshUntil|expiresAt|validityDeadline|myshopify|callback|accessToken/,
    );
    assert.equal(state.failures, 0);
  });

  it("omits the creation-only key from new and previously persisted profile replacements", async () => {
    const mock = auraMock();
    const initial = publication();
    await finish(initial, mock);
    const refresh = beginPublication(
      mapShipping(fixture),
      "run-2",
      2,
      fixture.acquiredAt,
      initial.mappings,
    );
    await publishShippingStep(refresh, context, 0, mock.fetcher);
    const pending = refresh.work[0].pending;
    if (pending?.kind !== "replace") assert.fail("expected a replacement");
    const expected = structuredClone(pending.body);
    assert.deepEqual(expected.import, {
      integration: contract.providerCreate.import.integration,
      sequence: 5,
      acquiredAt: fixture.acquiredAt,
      requestKey: `run-2:${refresh.work[0].key}`,
      observation: {},
    });
    // Earlier releases persisted the same request with the creation key.
    pending.body.import = {
      ...expected.import,
      objectKey: refresh.work[0].key,
    };
    const restarted = JSON.parse(JSON.stringify(refresh));
    await publishShippingStep(restarted, context, 0, mock.fetcher);
    const sent = mock.calls.at(-1);
    assert.equal(sent?.method, "PUT");
    assert.deepEqual(sent?.body, expected);
    matchesContract("ReplaceShippingProfileData", sent?.body);
    assert.deepEqual(restarted.work[0].pending.body, expected);
    assert.equal(restarted.work[0].done, true);
    assert.equal(restarted.failures, 0);
    assert.equal(restarted.lastError, undefined);
  });

  it("persists immutable create identity after a lost response and a process restart", async () => {
    let state = publication();
    const mock = auraMock({ loseCreate: true });
    await publishShippingStep(state, context, 0, mock.fetcher);
    const saved = JSON.stringify(state);
    await publishShippingStep(state, context, 0, mock.fetcher);
    assert.equal(state.work[0].done, undefined);
    assert.equal(
      JSON.stringify(state.work[0].pending),
      JSON.stringify(JSON.parse(saved).work[0].pending),
    );
    state = JSON.parse(saved);
    await publishShippingStep(state, context, 0, mock.fetcher);
    const creates = mock.calls.filter((call) => call.method === "POST");
    assert.equal(creates.length, 2);
    assert.equal(creates[0].raw, creates[1].raw);
    assert.equal(state.mappings[state.work[0].key].id, profileId);
  });

  it("retries the same pending write when a successful HTTP response cannot be decoded", async () => {
    const state = publication();
    const mock = auraMock();
    await publishShippingStep(state, context, 0, mock.fetcher);
    const pending = JSON.stringify(state.work[0].pending);
    await publishShippingStep(
      state,
      context,
      0,
      async () =>
        new Response("{incomplete", {
          headers: { "Content-Type": "application/json" },
        }),
    );
    assert.equal(state.work[0].done, undefined);
    assert.equal(state.committed, 0);
    assert.equal(JSON.stringify(state.work[0].pending), pending);
    await publishShippingStep(state, context, 60_000, mock.fetcher);
    assert.equal(state.work[0].done, true);
    assert.equal(state.mappings[state.work[0].key].id, profileId);
  });

  it("retries missing listings independently without recreating catalog products", async () => {
    const state = publication();
    const mock = auraMock({ missingListing: true });
    for (let i = 0; i < 12; i++)
      await publishShippingStep(state, context, Date.now(), mock.fetcher);
    assert.ok(state.committed > 0);
    assert.ok(
      state.work.some(
        (work) =>
          work.resource.kind === "membership" &&
          !work.done &&
          work.attempts > 0,
      ),
    );
    assert.ok(
      mock.calls.every((call) => !call.path.endsWith("product-listings")),
    );
    mock.options.missingListing = false;
    await finish(state, mock);
  });

  it("preserves explicit partner edits/clears and requests reacquisition for revision conflicts", async () => {
    const manual = publication();
    await finish(manual, auraMock({ ownershipConflict: true }));
    assert.equal(manual.protected, 2);
    assert.equal(manual.reconcile, false);
    const conflicted = publication();
    const mock = auraMock({ conflict: true });
    await finish(conflicted, mock);
    assert.equal(conflicted.reconcile, true);
    const patches = mock.calls.filter((call) => call.method === "PATCH");
    assert.equal(patches.length, 1);
  });

  it("retains membership in an active profile that a partner has taken over", async () => {
    const state = publication();
    const mock = auraMock({ profileOwned: true });
    await finish(state, mock);
    assert.equal(state.protected, 2);
    assert.equal(state.failures, 0);
    const assigned = mock.calls.find(
      (call) => call.method === "PATCH" && call.path.includes("/101/"),
    )?.body as ProductListingDeliveryCommandData;
    assert.ok(assigned.delivery.state === "SET");
    assert.deepEqual(assigned.delivery.value.selection, {
      state: "SET",
      value: { kind: "EXPLICIT", profile_id: profileId },
    });
  });

  it("only retires confirmed missing identities and does not treat unsupported mapping as omission", () => {
    const previous = {
      "missing-profile": { id: profileId, providerId: "missing" },
    };
    const state = beginPublication(
      mapShipping(fixture),
      "run",
      2,
      fixture.acquiredAt,
      previous,
    );
    assert.equal(
      state.work.some((work) => work.resource.kind === "retire"),
      false,
    );
    addConfirmedRemovals(
      state,
      Object.keys(fixture.profiles).map(profileObjectKey),
    );
    assert.equal(
      state.work.filter((work) => work.resource.kind === "retire").length,
      1,
    );
  });

  it("uses equivalent operations for initial/manual and event refresh acquisitions", () => {
    const mapping = mapShipping(fixture);
    const initial = beginPublication(
      mapping,
      "initial",
      1,
      fixture.acquiredAt,
      {},
    );
    const refresh = beginPublication(
      mapping,
      "event",
      2,
      fixture.acquiredAt,
      {},
    );
    assert.deepEqual(initial.work, refresh.work);
  });

  it("applies independent assignments while another profile waits for retry", async () => {
    const state = publication();
    const mock = auraMock();
    // Profile 2 is delayed independently of the profile 1 membership.
    state.work[1].dueAt = Date.now() + 3600_000;
    for (let step = 0; step < 8; step++)
      await publishShippingStep(state, context, Date.now(), mock.fetcher);
    assert.ok(
      mock.calls.some(
        (call) => call.method === "PATCH" && call.path.includes("/101/"),
      ),
    );
    assert.equal(state.work[1].done, undefined);
  });

  it("keeps canonical returned evidence free of expiry fields", () => {
    const types = readFileSync(
      new URL("../app/generated/api/types.gen.ts", import.meta.url),
      "utf8",
    );
    const evidence = /export type DeliveryAssertionEvidence = \{([^}]+)\}/.exec(
      types,
    )?.[1];
    assert.ok(evidence);
    assert.match(evidence, /verifiedAt: string/);
    assert.doesNotMatch(
      evidence,
      /status|freshUntil|expiresAt|validityDeadline/,
    );
  });
});
