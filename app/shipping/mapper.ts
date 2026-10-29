import { CURRENCY_MINOR_UNITS as CURRENCIES } from "../currency";
import type {
  ShippingApplicabilityData,
  ShippingAreaData,
  ShippingCurrencyCode,
  ShippingMoneyData,
  ShippingProfileContentData,
  ShippingServiceData,
  ShippingTimeData,
  ShippingZoneData,
} from "../generated/api/types.gen";
import {
  type Acquisition,
  type Condition,
  isRegionMarket,
  MARKET_SHIPPING_OBJECT_KEY,
  type Mapping,
  type Market,
  type MarketOption,
  type MarketRate,
  type MarketRegion,
  type Method,
  type Money,
  profileObjectKey,
  type RateProvider,
  SHIPPING_LIMITS,
  ShippingReadError,
  sourceProductId,
} from "./model";

const RELEASE = "iso-codes-4.20.1" as const;

export function exactMoney(money: Money): ShippingMoneyData {
  if (!Object.hasOwn(CURRENCIES, money.currencyCode)) {
    throw new ShippingReadError("UNSUPPORTED_CURRENCY");
  }
  const currency = money.currencyCode as ShippingCurrencyCode;
  const exponent = CURRENCIES[currency];
  const match = /^(\d+)(?:\.(\d+))?$/.exec(money.amount);
  if (!match) throw new ShippingReadError("INVALID_MONEY");
  const fraction = match[2] ?? "";
  if (/[1-9]/.test(fraction.slice(exponent))) {
    throw new ShippingReadError("INEXACT_MINOR_UNITS");
  }
  const amount =
    BigInt(match[1]) * 10n ** BigInt(exponent) +
    BigInt(fraction.slice(0, exponent).padEnd(exponent, "0") || "0");
  // The generated client serializes numbers. Never round a u64 to fit JS.
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ShippingReadError("MONEY_OUT_OF_RANGE");
  }
  return { amount_minor: Number(amount), currency };
}

export function unrestricted(): ShippingApplicabilityData {
  return { class: null, variants: null, quantity: null, threshold: null };
}

function service(
  method: Method,
  limitations: Set<string>,
  code = `shopify:${method.id.split("/").at(-1)}`,
): ShippingServiceData {
  const result: ShippingServiceData = {
    code,
    applicability: unrestricted(),
    eligibility: "OFFERED",
    rate: null,
    lead_times: { handling: null, transit: null, total: null },
    features: [],
    arranger: null,
    performer: null,
  };
  // Aura supports a minimum seller-order threshold, but has no weight or
  // maximum basket constraint. Keep the whole affected offer unasserted.
  for (const condition of method.methodConditions) {
    const criteria = condition.conditionCriteria;
    if (
      condition.field !== "TOTAL_PRICE" ||
      condition.operator !== "GREATER_THAN_OR_EQUAL_TO" ||
      criteria.__typename !== "MoneyV2" ||
      criteria.amount === undefined ||
      criteria.currencyCode === undefined
    ) {
      limitations.add("UNSUPPORTED_RATE_CONDITION");
      result.eligibility = null;
      return result;
    }
    const minimum = exactMoney({
      amount: criteria.amount,
      currencyCode: criteria.currencyCode,
    });
    const prior = result.applicability.threshold?.minimum;
    if (prior && prior.currency !== minimum.currency) {
      limitations.add("UNSUPPORTED_RATE_CONDITION");
      result.eligibility = null;
      result.applicability = unrestricted();
      return result;
    }
    if (!prior || minimum.amount_minor > prior.amount_minor) {
      result.applicability.threshold = { minimum, scope: "SELLER_ORDER" };
    }
  }
  const provider = method.rateProvider;
  if (provider.__typename === "DeliveryParticipant") {
    result.rate = {
      price: { kind: "EXTERNALLY_CALCULATED", currency: null },
      basis: null,
      qualifying_scope: null,
      components: {},
    };
    limitations.add("EXTERNAL_RATES_REQUIRE_CHECKOUT");
  } else if (
    provider.__typename === "DeliveryRateDefinition" &&
    provider.price
  ) {
    const amount = exactMoney(provider.price);
    result.rate = {
      price:
        amount.amount_minor === 0
          ? { kind: "FREE", currency: amount.currency }
          : { kind: "FIXED", amount },
      // Shopify combines rates by profile/location group and cart contents.
      // That charge group is not an Aura item, order or physical shipment.
      basis: null,
      qualifying_scope: null,
      components: {},
    };
    limitations.add("SHOPIFY_CHARGE_GROUP_BASIS_UNAVAILABLE");
  } else {
    limitations.add("UNSUPPORTED_RATE_PROVIDER");
    result.eligibility = null;
  }
  return result;
}

function content(
  name: string,
  zones: ShippingZoneData[],
): ShippingProfileContentData {
  return {
    name,
    attributedPartyId: null,
    terms: {
      schema: "SHIP_TERMS_V1",
      collection: null,
      shipping: {
        kind: "COVERAGE",
        coverage: {
          reference_release: RELEASE,
          completeness: "PARTIAL",
          applicability: unrestricted(),
          exclusions: [],
          dispatch_origin: null,
          zones,
        },
      },
    },
  };
}

function providerCode(id: string) {
  const match = /^gid:\/\/shopify\/(\w+)\/(\d+)$/.exec(id);
  if (!match) throw new ShippingReadError("INVALID_PROVIDER_ID");
  return { type: match[1], id: match[2] };
}

// Shopify states transit in seconds without a business or calendar basis.
// Only whole days or hours convert exactly; anything else stays unasserted.
export function transitTime(rate?: MarketRate): ShippingTimeData | null {
  const minimum = rate?.transitTimeMinSeconds;
  const maximum = rate?.transitTimeMaxSeconds;
  if (
    !Number.isSafeInteger(minimum) ||
    !Number.isSafeInteger(maximum) ||
    (minimum as number) < 0 ||
    (maximum as number) < (minimum as number)
  )
    return null;
  for (const [unit, seconds] of [
    ["DAYS", 86_400],
    ["HOURS", 3_600],
  ] as const) {
    if ((minimum as number) % seconds || (maximum as number) % seconds)
      continue;
    if ((maximum as number) / seconds > 4_294_967_295) return null;
    return {
      minimum: (minimum as number) / seconds,
      maximum: (maximum as number) / seconds,
      unit,
      basis: null,
      trigger: null,
    };
  }
  return null;
}

// Market options are expressed as the methods of the legacy expansion, so a
// rate tier, free threshold, weight condition or carrier price keeps exactly
// the semantics, limitations and charge basis of the profile importer.
function marketServices(
  option: MarketOption,
  limitations: Set<string>,
): ShippingServiceData[] {
  const { type, id } = providerCode(option.id);
  const code = `shopify:${type}:${id}`;
  if (!option.uniform || option.rates === null) {
    // Collection, origin-location or unread tiers vary the rate per item.
    limitations.add(
      option.kind === "UNKNOWN"
        ? "UNSUPPORTED_RATE_PROVIDER"
        : option.rates === null
          ? "MARKET_RATE_TIER_LIMIT"
          : "MARKET_RATE_CONDITIONS_UNSUPPORTED",
    );
    return [
      service(
        {
          id: option.id,
          name: "",
          active: true,
          methodConditions: [],
          rateProvider: { __typename: "Unsupported", id: option.id },
        },
        new Set(),
        code,
      ),
    ];
  }
  const atLeast = (money: Money): Condition => ({
    field: "TOTAL_PRICE",
    operator: "GREATER_THAN_OR_EQUAL_TO",
    conditionCriteria: { __typename: "MoneyV2", ...money },
  });
  const fixed = (rate: MarketRate): RateProvider => ({
    __typename: "DeliveryRateDefinition",
    id: rate.id,
    price: rate.price,
  });
  const offers: {
    code: string;
    conditions: Condition[];
    provider: RateProvider;
    rate?: MarketRate;
  }[] = [];
  if (option.kind === "FLAT") {
    const rate = option.rates.length === 1 ? option.rates[0] : undefined;
    offers.push({
      code,
      conditions: [],
      provider: rate
        ? fixed(rate)
        : { __typename: "Unsupported", id: option.id },
      rate,
    });
  } else if (option.kind === "VALUE") {
    for (const rate of option.rates) {
      const conditions: Condition[] = [];
      if (rate.minValue && exactMoney(rate.minValue).amount_minor > 0)
        conditions.push(atLeast(rate.minValue));
      if (rate.maxValue)
        conditions.push({
          field: "TOTAL_PRICE",
          operator: "LESS_THAN_OR_EQUAL_TO",
          conditionCriteria: { __typename: "MoneyV2", ...rate.maxValue },
        });
      offers.push({
        code: `${code}:${providerCode(rate.id).id}`,
        conditions,
        provider: fixed(rate),
        rate,
      });
    }
  } else if (option.kind === "WEIGHT") {
    offers.push({
      code,
      conditions: [
        {
          field: "TOTAL_WEIGHT",
          operator: "GREATER_THAN_OR_EQUAL_TO",
          conditionCriteria: { __typename: "Weight" },
        },
      ],
      provider: { __typename: "DeliveryRateDefinition", id: option.id },
    });
  } else {
    offers.push({
      code,
      conditions: [],
      provider: { __typename: "DeliveryParticipant", id: option.id },
    });
  }
  // The free threshold is the option's cart subtotal, independent of tiers.
  if (option.freeMinimum)
    offers.push({
      code: `${code}:free`,
      conditions: [atLeast(option.freeMinimum)],
      provider: {
        __typename: "DeliveryRateDefinition",
        id: option.id,
        price: { amount: "0", currencyCode: option.currency },
      },
      rate: option.kind === "FLAT" ? option.rates[0] : undefined,
    });
  return offers.map((offer) => {
    const result = service(
      {
        id: option.id,
        name: "",
        active: true,
        methodConditions: offer.conditions,
        rateProvider: offer.provider,
      },
      limitations,
      offer.code,
    );
    if (result.rate) result.lead_times.transit = transitTime(offer.rate);
    return result;
  });
}

// A buyer belongs to the most specific market covering the destination. A
// market without its own shipping inherits from the next wider market, and
// the widest one from the store default of no shipping. Shopify infers that
// lineage from strict region subsets, so equal or crossing markets stay
// unresolved instead of guessing which one applies.
function marketZones(
  markets: Record<string, Market>,
  limitations: Set<string>,
): ShippingZoneData[] {
  const regional = Object.values(markets).filter(isRegionMarket);
  for (const market of Object.values(markets))
    if (
      market.status === "ACTIVE" &&
      !isRegionMarket(market) &&
      !["COMPANY_LOCATION", "LOCATION", "NONE"].includes(market.type)
    )
      limitations.add("MARKET_CONTEXT_UNSUPPORTED");
  const contains = (market: Market, region: MarketRegion) =>
    market.allRegions ||
    market.regions.some(
      (own) =>
        own.country === region.country &&
        (own.subdivision === null || own.subdivision === region.subdivision),
    );
  const within = (inner: Market, outer: Market) =>
    outer.allRegions ||
    (!inner.allRegions &&
      inner.regions.every((region) => contains(outer, region)));
  const resolve = (candidates: Market[]) => {
    let remaining = candidates;
    while (remaining.length) {
      const specific = remaining.find((market) =>
        remaining.every(
          (other) =>
            other === market ||
            (within(market, other) && !within(other, market)),
        ),
      );
      if (!specific) return undefined;
      if (specific.shipping) return specific;
      remaining = remaining.filter((market) => market !== specific);
    }
    return null;
  };
  const areas = new Map<Market, Map<string, ShippingAreaData>>();
  const cover = (
    market: Market | null | undefined,
    area: ShippingAreaData,
    limitation?: string,
  ) => {
    if (market === undefined) limitations.add("MARKET_OVERLAP_UNRESOLVED");
    else if (market?.shipping?.enabled) {
      if (limitation) limitations.add(limitation);
      const owned = areas.get(market) ?? new Map();
      owned.set(JSON.stringify(area), area);
      areas.set(market, owned);
    }
  };
  const regions = new Map<string, MarketRegion>();
  for (const market of regional)
    for (const region of market.regions) {
      if (!/^[A-Z]{2}$/.test(region.country))
        throw new ShippingReadError("INVALID_COUNTRY");
      regions.set(`${region.country}:${region.subdivision ?? ""}`, region);
    }
  // Shopify subdivision codes are not ISO 3166-2 codes. A country that is
  // split between markets is never asserted country-wide.
  const split = new Set(
    [...regions.values()]
      .filter((region) => region.subdivision !== null)
      .map((region) => region.country),
  );
  for (const region of regions.values()) {
    const owner = resolve(
      regional.filter((market) => contains(market, region)),
    );
    if (split.has(region.country))
      cover(
        owner,
        {
          kind: "UNRESOLVED",
          assertion: `Shopify market regions in ${region.country}`,
        },
        "SUBDIVISION_MAPPING_UNAVAILABLE",
      );
    else
      cover(owner, {
        kind: "COUNTRY",
        code: region.country,
        reference_release: RELEASE,
      });
  }
  const universal = regional.filter((market) => market.allRegions);
  if (universal.length)
    cover(
      resolve(universal),
      { kind: "UNRESOLVED", assertion: "Shopify market for all other regions" },
      "REST_OF_WORLD_UNRESOLVED",
    );
  const zones: ShippingZoneData[] = [];
  for (const market of regional) {
    const owned = areas.get(market);
    if (!owned) continue;
    const services = (market.shipping?.options ?? [])
      .filter((option) => option.active)
      .flatMap((option) => marketServices(option, limitations));
    if (!services.length) continue;
    if (services.length > 64)
      throw new ShippingReadError("AURA_POLICY_LIMIT_EXCEEDED");
    const sorted = [...owned.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, area]) => area);
    // Equal services per chunk keep a large market within the zone limit.
    for (let i = 0; i < sorted.length; i += 64)
      zones.push({
        areas: sorted.slice(i, i + 64),
        applicability: unrestricted(),
        services,
      });
  }
  if (zones.length > 64)
    throw new ShippingReadError("AURA_POLICY_LIMIT_EXCEEDED");
  return zones;
}

function mapProfiles(acquisition: Acquisition, limitations: Set<string>) {
  const profiles: Mapping["profiles"] = [];
  for (const profile of Object.values(acquisition.profiles)) {
    if (
      profile.groups.length !== 1 ||
      profile.locationsWithoutRatesCount > 0 ||
      profile.originLocationCount === 0 ||
      profile.sellingPlans
    ) {
      limitations.add("UNSUPPORTED_ORIGIN_OR_SELLING_PLAN_APPLICABILITY");
      continue;
    }
    const zones: ShippingZoneData[] = [];
    for (const zone of profile.groups[0].zones) {
      const areas: ShippingAreaData[] = zone.countries.flatMap(
        (country): ShippingAreaData[] => {
          if (country.code.restOfWorld || !country.code.countryCode) {
            limitations.add("REST_OF_WORLD_UNRESOLVED");
            return [
              { kind: "UNRESOLVED", assertion: "Shopify rest-of-world zone" },
            ];
          }
          const code = country.code.countryCode;
          if (!/^[A-Z]{2}$/.test(code))
            throw new ShippingReadError("INVALID_COUNTRY");
          if (country.provinces.length === 0) {
            return [{ kind: "COUNTRY", code, reference_release: RELEASE }];
          }
          // Shopify province codes are not a guaranteed ISO subdivision mapping.
          // Do not turn a subset of provinces into country-wide coverage.
          limitations.add("SUBDIVISION_MAPPING_UNAVAILABLE");
          return [
            {
              kind: "UNRESOLVED",
              assertion: `Shopify subdivisions in ${code}`,
            },
          ];
        },
      );
      const services = zone.methods
        .filter((method) => method.active)
        .map((method) => service(method, limitations));
      if (areas.length > 64 || services.length > 64) {
        throw new ShippingReadError("AURA_POLICY_LIMIT_EXCEEDED");
      }
      if (areas.length && services.length)
        zones.push({ areas, applicability: unrestricted(), services });
    }
    if (zones.length > 64)
      throw new ShippingReadError("AURA_POLICY_LIMIT_EXCEEDED");
    profiles.push({
      objectKey: profileObjectKey(profile.id),
      providerId: profile.id,
      isDefault: profile.default,
      content: content(profile.name, zones),
    });
  }
  return profiles;
}

// Identities a complete acquisition confirms as current. Only previously
// published profiles outside this set are retired, so switching between the
// profile and market models withdraws the terms of the other model.
export function observedProfileKeys(acquisition: Acquisition) {
  return acquisition.markets
    ? [MARKET_SHIPPING_OBJECT_KEY]
    : Object.keys(acquisition.profiles).map(profileObjectKey);
}

export function mapShipping(acquisition: Acquisition): Mapping {
  const limitations = new Set<string>();
  let profiles: Mapping["profiles"];
  let universal: string[];
  if (acquisition.markets) {
    // Market options apply to every shippable item, like a shop-wide
    // profile. Other apps' delivery profiles are not read for such shops.
    limitations.add("APP_PROVIDED_RATES_UNASSERTED");
    profiles = [
      {
        objectKey: MARKET_SHIPPING_OBJECT_KEY,
        providerId: "shopify:markets",
        isDefault: true,
        content: content(
          "Shopify market shipping",
          marketZones(acquisition.markets, limitations),
        ),
      },
    ];
    universal = [MARKET_SHIPPING_OBJECT_KEY];
  } else {
    profiles = mapProfiles(acquisition, limitations);
    universal = Object.values(acquisition.profiles)
      .filter((profile) => profile.coversAllItems)
      .map((profile) => profileObjectKey(profile.id));
  }
  const memberships: Mapping["memberships"] = [];
  for (const product of Object.values(acquisition.products)) {
    const selected = new Set<string>();
    let complete =
      product.variants.length > 0 &&
      product.variants.length <= SHIPPING_LIMITS.variants;
    for (const variant of product.variants) {
      const candidates = universal.length
        ? product.shippableVariants?.includes(variant)
          ? universal
          : []
        : Object.values(acquisition.profiles)
            .filter((profile) =>
              profile.memberships[product.id]?.includes(variant),
            )
            .map((profile) => profileObjectKey(profile.id));
      if (candidates.length !== 1) complete = false;
      else selected.add(candidates[0]);
    }
    const objectKey = complete && selected.size === 1 ? [...selected][0] : null;
    const mapped = profiles.some((profile) => profile.objectKey === objectKey);
    if (!objectKey || !mapped) limitations.add("MIXED_OR_UNKNOWN_MEMBERSHIP");
    memberships.push({
      sourceListingId: sourceProductId(product.id),
      profileObjectKey: mapped ? objectKey : null,
      variants: complete ? product.variants : null,
    });
  }
  return { profiles, memberships, limitations: [...limitations].sort() };
}
