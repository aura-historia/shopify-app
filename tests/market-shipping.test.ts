import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import Ajv from "ajv";
import type { GraphqlRequestFn } from "../app/backfill.server";
import type {
  ShippingServiceData,
  ShippingZoneData,
} from "../app/generated/api/types.gen";
import {
  acquireShippingStep,
  beginAcquisition,
} from "../app/shipping/acquisition.server";
import { mapShipping, observedProfileKeys } from "../app/shipping/mapper";
import {
  type Acquisition,
  MARKET_SHIPPING_OBJECT_KEY,
  type Mapping,
  type Market,
  profileObjectKey,
} from "../app/shipping/model";
import {
  addConfirmedRemovals,
  beginPublication,
} from "../app/shipping/publisher.server";
import { shippingLimitationMessage } from "../app/shipping/status";
import {
  fixture,
  fixtureGraphql,
  marketFixture,
  marketGraphql,
} from "./helpers/shipping-fixtures";

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

async function acquire(request: GraphqlRequestFn) {
  const state = beginAcquisition(fixture.acquiredAt);
  while (state.tasks.length) {
    await acquireShippingStep(state, request);
    // Exercise checkpoint roundtrips between every bounded request.
    Object.assign(state, JSON.parse(JSON.stringify(state)));
    assert.ok(state.pages < 400);
  }
  return state.snapshot;
}

function zones(mapping: Mapping) {
  const policy = mapping.profiles[0].content.terms.shipping;
  assert.ok(policy?.kind === "COVERAGE");
  return policy.coverage.zones;
}

function areas(zone: ShippingZoneData) {
  return zone.areas.map((area) =>
    area.kind === "COUNTRY"
      ? area.code
      : area.kind === "UNRESOLVED"
        ? area.assertion
        : area.kind,
  );
}

function offers(zone: ShippingZoneData) {
  return zone.services.map((service: ShippingServiceData) => ({
    code: service.code,
    eligibility: service.eligibility,
    price: service.rate?.price ?? null,
    threshold: service.applicability.threshold,
    transit: service.lead_times.transit,
  }));
}

const days = (minimum: number, maximum: number) => ({
  minimum,
  maximum,
  unit: "DAYS",
  basis: null,
  trigger: null,
});
const eur = (amount_minor: number) => ({ amount_minor, currency: "EUR" });

let acquired: Acquisition | undefined;
async function marketSnapshot() {
  acquired ??= await acquire(marketGraphql().request);
  return structuredClone(acquired);
}

function market(
  id: number,
  regions: [string, string?][],
  shipping: Market["shipping"],
  overrides: Partial<Market> = {},
): Market {
  return {
    id: `gid://shopify/Market/${id}`,
    type: "REGION",
    status: "ACTIVE",
    conditionTypes: ["REGION"],
    allRegions: false,
    regions: regions.map(([country, subdivision], i) => ({
      id: `gid://shopify/MarketRegion/${id}${i}`,
      country,
      subdivision: subdivision ?? null,
    })),
    shipping,
    ...overrides,
  };
}

function flat(id: number, amount: string, currency = "EUR") {
  return {
    enabled: true,
    options: [
      {
        id: `gid://shopify/DeliveryFlatRateOptionDefinition/${id}`,
        kind: "FLAT" as const,
        active: true,
        currency,
        freeMinimum: null,
        uniform: true,
        rates: [
          {
            id: `gid://shopify/DeliveryFlatRate/${id}`,
            price: { amount, currencyCode: currency },
            transitTimeMinSeconds: null,
            transitTimeMaxSeconds: null,
          },
        ],
      },
    ],
  };
}

describe("market-driven Shopify shipping", () => {
  it("pins the 2026-10 Markets read surface, scope and notification evidence", () => {
    const { evidence } = marketFixture;
    assert.equal(evidence.detection, "ShopFeatures.marketDrivenShipping");
    assert.equal(evidence.requiredScope, "read_markets");
    assert.deepEqual(evidence.webhookTopics, [
      "markets/create",
      "markets/update",
      "markets/delete",
    ]);
    assert.deepEqual(evidence.validatedOperations, [
      "ShippingPreflight",
      "ShippingModel",
      "ShippingMarkets",
      "ShippingMarketRegions",
      "ShippingMarketOptions",
    ]);
    for (const reference of evidence.references as string[])
      assert.match(reference, /^https:\/\/shopify\.dev\//);
  });

  it("reads every market, region and option page instead of legacy profiles", async () => {
    const mock = marketGraphql();
    const snapshot = await acquire(mock.request);
    assert.deepEqual(snapshot.profiles, {});
    assert.equal(Object.keys(snapshot.markets ?? {}).length, 6);
    const names = mock.calls.map((call) => call.name);
    for (const legacy of [
      "ShippingProfiles",
      "ShippingItems",
      "ShippingZones",
      "ShippingMembershipVariants",
    ])
      assert.equal(names.includes(legacy), false, legacy);
    for (const name of [
      "ShippingMarkets",
      "ShippingMarketRegions",
      "ShippingMarketOptions",
      "ShippingProducts",
      "ShippingVariants",
    ])
      assert.ok(
        mock.calls.some((call) => call.name === name && call.variables.after),
        name,
      );
    // Draft, B2B and inherited markets are read only as headers.
    for (const id of [3, 5, 6])
      assert.equal(
        mock.calls.some(
          (call) =>
            call.name === "ShippingMarketOptions" &&
            call.variables.id === `gid://shopify/Market/${id}`,
        ),
        false,
      );
    // Every market is read twice: once to acquire it and once to verify it.
    assert.equal(
      names.filter((name) => name === "ShippingMarketOptions").length,
      2 * (2 + 5 + 1),
    );
  });

  it("maps markets, destinations, options, tiers and transit into one exact typed profile", async () => {
    const mapping = mapShipping(await marketSnapshot());
    assert.equal(mapping.profiles.length, 1);
    const [profile] = mapping.profiles;
    assert.equal(profile.objectKey, MARKET_SHIPPING_OBJECT_KEY);
    assert.equal(profile.isDefault, true);
    matchesContract("ShippingProfileContentData", profile.content);
    const policy = profile.content.terms.shipping;
    assert.ok(policy?.kind === "COVERAGE");
    assert.equal(policy.coverage.completeness, "PARTIAL");
    assert.equal(policy.coverage.dispatch_origin, null);
    const [unitedStates, europe, austria, ...rest] = zones(mapping);
    assert.equal(rest.length, 0);
    assert.deepEqual(areas(unitedStates), ["US"]);
    // Germany has no shipping of its own and inherits from Europe. Austria's
    // own market is more specific than Europe.
    assert.deepEqual(areas(europe), ["DE", "FR"]);
    assert.deepEqual(areas(austria), ["AT"]);
    const standard = "shopify:DeliveryFlatRateOptionDefinition:11";
    assert.deepEqual(offers(unitedStates), [
      // Below the free-delivery minimum only: an upper bound Aura lacks.
      {
        code: standard,
        eligibility: null,
        price: null,
        threshold: null,
        transit: null,
      },
      {
        code: `${standard}:free`,
        eligibility: "OFFERED",
        price: { kind: "FREE", currency: "EUR" },
        threshold: { minimum: eur(5000), scope: "SELLER_ORDER" },
        transit: days(3, 5),
      },
      {
        code: "shopify:DeliveryFlatRateOptionDefinition:12",
        eligibility: "OFFERED",
        price: { kind: "FIXED", amount: eur(2900) },
        threshold: null,
        transit: days(1, 2),
      },
    ]);
    assert.deepEqual(offers(europe), [
      // An upper cart-value bound has no Aura representation.
      {
        code: "shopify:DeliveryValueBasedOptionDefinition:21:2111",
        eligibility: null,
        price: null,
        threshold: null,
        transit: null,
      },
      {
        code: "shopify:DeliveryValueBasedOptionDefinition:21:2112",
        eligibility: "OFFERED",
        price: { kind: "FREE", currency: "EUR" },
        threshold: { minimum: eur(5000), scope: "SELLER_ORDER" },
        transit: days(2, 4),
      },
      // A collection-conditioned rate does not apply to every product.
      {
        code: "shopify:DeliveryFlatRateOptionDefinition:22",
        eligibility: null,
        price: null,
        threshold: null,
        transit: null,
      },
      {
        code: "shopify:DeliveryCarrierCalculatedOptionDefinition:23",
        eligibility: "OFFERED",
        price: { kind: "EXTERNALLY_CALCULATED", currency: null },
        threshold: null,
        transit: null,
      },
      {
        code: "shopify:DeliveryWeightBasedOptionDefinition:24",
        eligibility: null,
        price: null,
        threshold: null,
        transit: null,
      },
    ]);
    // 90 to 120 minutes are not whole hours, so transit stays unasserted.
    assert.deepEqual(offers(austria), [
      {
        code: "shopify:DeliveryFlatRateOptionDefinition:41",
        eligibility: "OFFERED",
        price: { kind: "FIXED", amount: eur(1200) },
        threshold: null,
        transit: null,
      },
    ]);
    for (const zone of zones(mapping))
      for (const service of zone.services) {
        assert.equal(service.rate?.basis ?? null, null);
        assert.equal(service.rate?.qualifying_scope ?? null, null);
      }
    assert.deepEqual(mapping.limitations, [
      "APP_PROVIDED_RATES_UNASSERTED",
      "EXTERNAL_RATES_REQUIRE_CHECKOUT",
      "MARKET_RATE_CONDITIONS_UNSUPPORTED",
      "SHOPIFY_CHARGE_GROUP_BASIS_UNAVAILABLE",
      "UNSUPPORTED_RATE_CONDITION",
    ]);
    const fallback = shippingLimitationMessage("UNKNOWN");
    for (const code of mapping.limitations)
      assert.notEqual(shippingLimitationMessage(code), fallback, code);
    // Market options apply to every shippable variant.
    assert.deepEqual(
      mapping.memberships.map((membership) => [
        membership.sourceListingId,
        membership.profileObjectKey,
        membership.variants?.length,
      ]),
      [
        ["101", MARKET_SHIPPING_OBJECT_KEY, 2],
        ["102", MARKET_SHIPPING_OBJECT_KEY, 2],
      ],
    );
  });

  it("resolves the most specific market and inheritance without guessing overlaps or subdivisions", async () => {
    const base = await marketSnapshot();
    const resolve = (...extra: Market[]) => {
      const snapshot = structuredClone(base);
      for (const added of extra)
        (snapshot.markets as Record<string, Market>)[added.id] = added;
      const mapping = mapShipping(snapshot);
      for (const profile of mapping.profiles)
        matchesContract("ShippingProfileContentData", profile.content);
      return {
        mapping,
        coverage: zones(mapping).map((zone) => [
          zone.services[0].code,
          areas(zone),
        ]),
      };
    };
    // Germany's own options take precedence over the wider European market.
    const germany = resolve(market(3, [["DE"]], flat(31, "5.00")));
    assert.deepEqual(germany.coverage.slice(1, 3), [
      ["shopify:DeliveryValueBasedOptionDefinition:21:2111", ["FR"]],
      ["shopify:DeliveryFlatRateOptionDefinition:31", ["DE"]],
    ]);
    // Germany inherits, but Europe and a crossing market both contain DE.
    const crossing = resolve(market(7, [["DE"], ["PL"]], flat(71, "6.00")));
    assert.deepEqual(crossing.coverage.slice(1), [
      ["shopify:DeliveryValueBasedOptionDefinition:21:2111", ["FR"]],
      ["shopify:DeliveryFlatRateOptionDefinition:41", ["AT"]],
      ["shopify:DeliveryFlatRateOptionDefinition:71", ["PL"]],
    ]);
    assert.ok(
      crossing.mapping.limitations.includes("MARKET_OVERLAP_UNRESOLVED"),
    );
    // A subdivision market that inherits leaves the whole country uniform.
    const inheriting = resolve(market(8, [["US", "CA"]], null));
    assert.deepEqual(inheriting.coverage[0], [
      "shopify:DeliveryFlatRateOptionDefinition:11",
      ["US"],
    ]);
    // Shopify subdivision codes are not ISO codes; a split country is never
    // asserted country-wide, also for the market that covers the rest of it.
    const california = resolve(market(8, [["US", "CA"]], flat(81, "4.00")));
    assert.deepEqual(
      california.coverage.filter(([, codes]) =>
        codes.includes("Shopify market regions in US"),
      ),
      [
        [
          "shopify:DeliveryFlatRateOptionDefinition:11",
          ["Shopify market regions in US"],
        ],
        [
          "shopify:DeliveryFlatRateOptionDefinition:81",
          ["Shopify market regions in US"],
        ],
      ],
    );
    assert.ok(
      california.mapping.limitations.includes(
        "SUBDIVISION_MAPPING_UNAVAILABLE",
      ),
    );
    // A root market without shipping inherits the store default: none.
    const switzerland = resolve(market(9, [["CH"]], null));
    assert.deepEqual(
      switzerland.coverage.flatMap(([, codes]) => codes),
      ["US", "DE", "FR", "AT"],
    );
    assert.equal(
      switzerland.mapping.limitations.includes("MARKET_OVERLAP_UNRESOLVED"),
      false,
    );
    // A market for all regions is the parent of every other market.
    const worldwide = resolve(
      market(9, [["CH"]], null),
      market(10, [], flat(101, "25.00"), { allRegions: true }),
    );
    assert.deepEqual(worldwide.coverage.at(-1), [
      "shopify:DeliveryFlatRateOptionDefinition:101",
      ["CH", "Shopify market for all other regions"],
    ]);
    assert.ok(
      worldwide.mapping.limitations.includes("REST_OF_WORLD_UNRESOLVED"),
    );
    // Crossing markets resolve when every path reaches the same shipping.
    const parents = [
      market(13, [["PL"], ["CH"]], null),
      market(14, [["PL"], ["IT"]], null),
      market(10, [], flat(101, "25.00"), { allRegions: true }),
    ] as const;
    assert.deepEqual(resolve(...parents).coverage.at(-1), [
      "shopify:DeliveryFlatRateOptionDefinition:101",
      ["CH", "IT", "PL", "Shopify market for all other regions"],
    ]);
    const diverging = resolve(
      market(13, [["PL"], ["CH"]], flat(131, "3.00")),
      parents[1],
      parents[2],
    );
    assert.deepEqual(diverging.coverage.slice(-2), [
      ["shopify:DeliveryFlatRateOptionDefinition:131", ["CH"]],
      [
        "shopify:DeliveryFlatRateOptionDefinition:101",
        ["IT", "Shopify market for all other regions"],
      ],
    ]);
    assert.ok(
      diverging.mapping.limitations.includes("MARKET_OVERLAP_UNRESOLVED"),
    );
    // Disabled shipping in the most specific market offers nothing there.
    const disabled = structuredClone(base);
    const austria = disabled.markets?.["gid://shopify/Market/4"];
    assert.ok(austria?.shipping);
    austria.shipping.enabled = false;
    assert.deepEqual(
      zones(mapShipping(disabled)).flatMap((zone) => areas(zone)),
      ["US", "DE", "FR"],
    );
    // Channel or combined-condition markets are reported, not applied.
    const channel = resolve(
      market(11, [], flat(111, "1.00"), {
        type: "CHANNEL",
        conditionTypes: ["CHANNEL"],
      }),
    );
    assert.ok(
      channel.mapping.limitations.includes("MARKET_CONTEXT_UNSUPPORTED"),
    );
    assert.deepEqual(channel.coverage, resolve().coverage);
    // A channel-scoped region market shapes that channel's product feed; the
    // region market still decides the online store checkout.
    const combined = resolve(
      market(15, [["US"]], flat(151, "1.00"), {
        conditionTypes: ["CHANNEL", "REGION"],
      }),
    );
    assert.ok(
      combined.mapping.limitations.includes("MARKET_CONTEXT_UNSUPPORTED"),
    );
    assert.deepEqual(combined.coverage, resolve().coverage);
  });

  it("keeps currencies exact and splits large markets within Aura zone limits", async () => {
    const base = await marketSnapshot();
    const yen = structuredClone(base);
    const option = yen.markets?.["gid://shopify/Market/4"].shipping?.options[0];
    assert.ok(option?.rates);
    option.currency = "JPY";
    option.rates[0].price = { amount: "1200.0", currencyCode: "JPY" };
    assert.deepEqual(zones(mapShipping(yen))[2].services[0].rate?.price, {
      kind: "FIXED",
      amount: { amount_minor: 1200, currency: "JPY" },
    });
    // Markets set their own currencies. An option Aura cannot represent
    // exactly stays unasserted without failing the other markets.
    for (const [amount, currencyCode] of [
      ["1200.5", "JPY"],
      ["12.00", "ILS"],
    ]) {
      option.currency = currencyCode;
      option.rates[0].price = { amount, currencyCode };
      const mapping = mapShipping(yen);
      const [austria] = zones(mapping).slice(2);
      assert.deepEqual(
        austria.services.map((service) => [
          service.code,
          service.eligibility,
          service.rate,
        ]),
        [["shopify:DeliveryFlatRateOptionDefinition:41", null, null]],
      );
      assert.ok(mapping.limitations.includes("MARKET_CURRENCY_UNSUPPORTED"));
      assert.equal(
        zones(mapping)[0].services.at(-1)?.rate?.price.kind,
        "FIXED",
      );
    }
    option.rates[0].price = { amount: "twelve", currencyCode: "EUR" };
    assert.throws(() => mapShipping(yen), /INVALID_MONEY/);
    const large = structuredClone(base);
    const countries = Array.from({ length: 70 }, (_, i) =>
      String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)),
    ).filter((code) => !["AT", "DE", "FR", "US"].includes(code));
    (large.markets as Record<string, Market>)["gid://shopify/Market/12"] =
      market(
        12,
        countries.map((code) => [code]),
        flat(121, "30.00"),
      );
    const split = zones(mapShipping(large)).slice(3);
    assert.deepEqual(
      split.map((zone) => zone.areas.length),
      [64, countries.length - 64],
    );
    assert.deepEqual(split[0].services, split[1].services);
  });

  it("never asserts a paid price above a free-delivery minimum or a free price the option may not offer", async () => {
    const snapshot = await marketSnapshot();
    const europe = snapshot.markets?.["gid://shopify/Market/2"].shipping;
    assert.ok(europe);
    const [value, , carrier, weight] = europe.options;
    for (const option of [value, carrier, weight])
      option.freeMinimum = { amount: "40.00", currencyCode: "EUR" };
    const mapping = mapShipping(snapshot);
    const services = Object.fromEntries(
      zones(mapping)[1].services.map((service) => [
        service.code.replace(/^shopify:Delivery/, ""),
        [
          service.eligibility,
          service.rate?.price.kind ?? null,
          service.applicability.threshold?.minimum.amount_minor ?? null,
        ],
      ]),
    );
    assert.deepEqual(services, {
      // The 0.00 tier from 50 stays free; the paid tier only applies below 40.
      "ValueBasedOptionDefinition:21:2111": [null, null, null],
      "ValueBasedOptionDefinition:21:2112": ["OFFERED", "FREE", 5000],
      // The open tier starts above 40, so 40-49.99 carts may get no offer.
      "ValueBasedOptionDefinition:21:free": [null, null, null],
      "FlatRateOptionDefinition:22": [null, null, null],
      "CarrierCalculatedOptionDefinition:23": [null, null, null],
      "CarrierCalculatedOptionDefinition:23:free": [null, null, null],
      "WeightBasedOptionDefinition:24": [null, null, null],
      "WeightBasedOptionDefinition:24:free": [null, null, null],
    });
    // A value tier open from the minimum keeps the free price asserted.
    value.freeMinimum = { amount: "50.00", currencyCode: "EUR" };
    assert.deepEqual(
      zones(mapShipping(snapshot))[1]
        .services.filter((service) => service.code.endsWith(":free"))
        .map((service) => [service.code, service.eligibility]),
      [
        ["shopify:DeliveryValueBasedOptionDefinition:21:free", "OFFERED"],
        ["shopify:DeliveryCarrierCalculatedOptionDefinition:23:free", null],
        ["shopify:DeliveryWeightBasedOptionDefinition:24:free", null],
      ],
    );
  });

  it("reads all-region markets without a region list and treats absent rate groups as unrepresentable", async () => {
    const markets = structuredClone(marketFixture.markets);
    markets[2].conditions = {
      conditionTypes: ["REGION"],
      regionsCondition: { applicationLevel: "ALL" },
    };
    markets[2].regions = [];
    markets[2].shipping = structuredClone(markets[3].shipping);
    const option = markets[2].shipping?.optionDefinitions[0] as Record<
      string,
      unknown
    >;
    option.id = "gid://shopify/DeliveryFlatRateOptionDefinition/31";
    option.flatGroups = null;
    const mock = marketGraphql(markets);
    const mapping = mapShipping(await acquire(mock.request));
    assert.equal(
      mock.calls.some(
        (call) =>
          call.name === "ShippingMarketRegions" &&
          call.variables.id === markets[2].id,
      ),
      false,
    );
    // Germany's market now covers all regions and owns Austria's old options.
    const worldwide = zones(mapping).find((zone) =>
      zone.services.some(
        (service) =>
          service.code === "shopify:DeliveryFlatRateOptionDefinition:31",
      ),
    );
    assert.deepEqual(worldwide?.areas, [
      { kind: "UNRESOLVED", assertion: "Shopify market for all other regions" },
    ]);
    assert.deepEqual(
      worldwide?.services.map((service) => [
        service.code,
        service.eligibility,
        service.rate,
      ]),
      [["shopify:DeliveryFlatRateOptionDefinition:31", null, null]],
    );
    assert.ok(
      mapping.limitations.includes("MARKET_RATE_CONDITIONS_UNSUPPORTED"),
    );
  });

  it("leaves conditioned, multi-group and over-long options conditional", async () => {
    const markets = structuredClone(marketFixture.markets);
    const [standard, express] = markets[0].shipping?.optionDefinitions ?? [];
    const groups = (option: Record<string, unknown>, key: string) =>
      option[key] as {
        nodes: { conditions: Record<string, unknown> }[];
        pageInfo: { hasNextPage: boolean };
      };
    // Rates that depend on the fulfillment location.
    groups(standard, "flatGroups").nodes[0].conditions.originLocationsCount = {
      count: 1,
    };
    // A second rate group always varies the rate by product or origin.
    groups(express, "flatGroups").pageInfo.hasNextPage = true;
    const tiers = groups(
      markets[1].shipping?.optionDefinitions[0] ?? {},
      "valueGroups",
    ).nodes[0] as unknown as { rates: { pageInfo: { hasNextPage: boolean } } };
    tiers.rates.pageInfo.hasNextPage = true;
    const mapping = mapShipping(await acquire(marketGraphql(markets).request));
    const [unitedStates, europe] = zones(mapping);
    assert.deepEqual(
      unitedStates.services.map((service) => [
        service.code,
        service.eligibility,
        service.rate,
      ]),
      [
        ["shopify:DeliveryFlatRateOptionDefinition:11", null, null],
        ["shopify:DeliveryFlatRateOptionDefinition:12", null, null],
      ],
    );
    assert.deepEqual(europe.services[0], {
      ...europe.services[0],
      code: "shopify:DeliveryValueBasedOptionDefinition:21",
      eligibility: null,
      rate: null,
    });
    assert.ok(mapping.limitations.includes("MARKET_RATE_TIER_LIMIT"));
    assert.ok(
      mapping.limitations.includes("MARKET_RATE_CONDITIONS_UNSUPPORTED"),
    );
  });

  it("restarts when markets change during the read and never trusts a torn snapshot", async () => {
    for (const change of [
      (mock: ReturnType<typeof marketGraphql>) => {
        const option = mock.markets[0].shipping?.optionDefinitions[0] as {
          flatGroups: { nodes: { rate: { price: { amount: string } } }[] };
        };
        option.flatGroups.nodes[0].rate.price.amount = "18.00";
      },
      (mock: ReturnType<typeof marketGraphql>) => {
        mock.markets[1].regions.pop();
      },
      (mock: ReturnType<typeof marketGraphql>) => {
        mock.markets.splice(3, 1);
      },
      (mock: ReturnType<typeof marketGraphql>) => {
        const shipping = mock.markets[2];
        shipping.shipping = { isEnabled: true, optionDefinitions: [] };
      },
    ]) {
      const mock = marketGraphql();
      const state = beginAcquisition(fixture.acquiredAt);
      while (!state.verifying) await acquireShippingStep(state, mock.request);
      change(mock);
      await assert.rejects(async () => {
        while (state.tasks.length)
          await acquireShippingStep(state, mock.request);
      }, /SHOPIFY_CHANGED_DURING_READ/);
    }
    // A shop that moves to Markets while its profiles are read is not
    // published from the deprecated, unchanged profile snapshot.
    const legacy = fixtureGraphql();
    let moved = false;
    const switching: GraphqlRequestFn = async (query, variables) => {
      const body = await legacy.request(query, variables);
      if (moved && query.includes("ShippingModel"))
        return { data: { shop: { features: { marketDrivenShipping: true } } } };
      return body;
    };
    const profileRead = beginAcquisition(fixture.acquiredAt);
    while (!profileRead.verifying)
      await acquireShippingStep(profileRead, switching);
    moved = true;
    await assert.rejects(async () => {
      while (profileRead.tasks.length)
        await acquireShippingStep(profileRead, switching);
    }, /SHOPIFY_CHANGED_DURING_READ/);
    // A market removed between its header and options page is a change too.
    const mock = marketGraphql();
    const state = beginAcquisition(fixture.acquiredAt);
    while (!state.tasks.some((task) => task.kind === "marketOptions"))
      await acquireShippingStep(state, mock.request);
    mock.markets.splice(0, 1);
    await assert.rejects(async () => {
      while (state.tasks.length) await acquireShippingStep(state, mock.request);
    }, /SHOPIFY_CHANGED_DURING_READ/);
  });

  it("requires read_markets and a known schema before reading market-driven shops", async () => {
    for (const [scopes, schema, expected] of [
      [["read_shipping"], true, /SHIPPING_PERMISSION_REQUIRED/],
      [["read_markets"], false, /UNSUPPORTED_SHOPIFY_SCHEMA/],
    ] as const) {
      const mock = marketGraphql();
      mock.controls.scopes = [...scopes];
      const request: GraphqlRequestFn = async (query, variables) => {
        const body = (await mock.request(query, variables)) as {
          data: { shipping: unknown };
        };
        if (!schema) body.data.shipping = null;
        return body;
      };
      await assert.rejects(
        acquireShippingStep(beginAcquisition(fixture.acquiredAt), request),
        expected,
      );
    }
    const unknown = marketGraphql();
    (unknown.controls as { marketDriven: unknown }).marketDriven = null;
    await assert.rejects(
      acquireShippingStep(
        beginAcquisition(fixture.acquiredAt),
        unknown.request,
      ),
      /UNSUPPORTED_SHOPIFY_SCHEMA/,
    );
    // write_markets includes read access to Markets.
    const writer = marketGraphql();
    writer.controls.scopes = ["write_markets"];
    const state = beginAcquisition(fixture.acquiredAt);
    await acquireShippingStep(state, writer.request);
    assert.equal(state.tasks[0].kind, "markets");
    // Shopify reports a revoked scope on the market read itself.
    await assert.rejects(
      acquireShippingStep(state, async () => ({
        errors: [{ extensions: { code: "ACCESS_DENIED" } }],
      })),
      /SHIPPING_PERMISSION_REQUIRED/,
    );
    const subdivisionless = structuredClone(marketFixture.markets);
    subdivisionless[0].regions = [
      { __typename: "MarketRegionFuture", id: "gid://shopify/Future/1" },
    ];
    await assert.rejects(
      acquire(marketGraphql(subdivisionless).request),
      /UNSUPPORTED_SHOPIFY_SCHEMA/,
    );
  });

  it("retires the other model's terms when a shop switches shipping models", async () => {
    const snapshot = await marketSnapshot();
    const legacyKey = profileObjectKey("gid://shopify/DeliveryProfile/1");
    const toMarkets = beginPublication(
      mapShipping(snapshot),
      "switch",
      2,
      snapshot.acquiredAt,
      {
        [legacyKey]: {
          id: "shp_legacy",
          providerId: "gid://shopify/DeliveryProfile/1",
        },
      },
    );
    addConfirmedRemovals(toMarkets, observedProfileKeys(snapshot));
    assert.deepEqual(
      toMarkets.work.flatMap((work) =>
        work.resource.kind === "retire" ? [work.resource.objectKey] : [],
      ),
      [legacyKey],
    );
    const toProfiles = beginPublication(
      mapShipping(fixture),
      "rollback",
      3,
      fixture.acquiredAt,
      {
        [MARKET_SHIPPING_OBJECT_KEY]: {
          id: "shp_market",
          providerId: "shopify:markets",
        },
      },
    );
    addConfirmedRemovals(toProfiles, observedProfileKeys(fixture));
    assert.deepEqual(
      toProfiles.work.flatMap((work) =>
        work.resource.kind === "retire" ? [work.resource.objectKey] : [],
      ),
      [MARKET_SHIPPING_OBJECT_KEY],
    );
  });
});
