import { CURRENCY_MINOR_UNITS as CURRENCIES } from "../currency";
import type {
  ShippingApplicabilityData,
  ShippingAreaData,
  ShippingCurrencyCode,
  ShippingMoneyData,
  ShippingServiceData,
  ShippingZoneData,
} from "../generated/api/types.gen";
import {
  type Acquisition,
  type Mapping,
  type Method,
  type Money,
  profileObjectKey,
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
): ShippingServiceData {
  const result: ShippingServiceData = {
    code: `shopify:${method.id.split("/").at(-1)}`,
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

export function mapShipping(acquisition: Acquisition): Mapping {
  const limitations = new Set<string>();
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
      content: {
        name: profile.name,
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
      },
    });
  }
  const memberships: Mapping["memberships"] = [];
  const universal = Object.values(acquisition.profiles).filter(
    (profile) => profile.coversAllItems,
  );
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
        : Object.values(acquisition.profiles).filter((profile) =>
            profile.memberships[product.id]?.includes(variant),
          );
      if (candidates.length !== 1) complete = false;
      else selected.add(profileObjectKey(candidates[0].id));
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
