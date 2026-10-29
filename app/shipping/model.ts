import type {
  ListingDeliveryIntegrationData,
  ShippingProfileContentData,
} from "../generated/api/types.gen";

export const SHOPIFY_SHIPPING_INTEGRATION = {
  kind: "PROVIDER",
  method: "SHOPIFY",
} as const satisfies ListingDeliveryIntegrationData;
export const SHIPPING_API_VERSION = "2026-10";
export const SHIPPING_LIMITS = {
  pageSize: 50,
  pages: 4000,
  profiles: 100,
  markets: 100,
  // Each option page nests its first rate group and cart-value tiers; keep the
  // requested query cost well below Shopify's single-query maximum.
  optionPageSize: 5,
  rateTiers: 25,
  products: 5000,
  variants: 64,
  bytes: 4_000_000,
  retries: 8,
} as const;
// Market-driven shipping is one shop-wide configuration of market options.
export const MARKET_SHIPPING_OBJECT_KEY = "shopify:market-shipping";

export class ShippingReadError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
export interface Money {
  amount: string;
  currencyCode: string;
}
export interface Condition {
  field: string;
  operator: string;
  conditionCriteria: {
    __typename: string;
    amount?: string;
    currencyCode?: string;
    value?: number;
    unit?: string;
  };
}
export interface RateProvider {
  __typename: string;
  id: string;
  price?: Money;
}
export interface Method {
  id: string;
  active: boolean;
  name: string;
  methodConditions: Condition[];
  rateProvider: RateProvider;
}
export interface Country {
  code: { countryCode: string | null; restOfWorld: boolean };
  provinces: { code: string }[];
}
export interface Zone {
  id: string;
  countries: Country[];
  methods: Method[];
}
export interface Profile {
  id: string;
  name: string;
  version: number;
  default: boolean;
  coversAllItems: boolean;
  originLocationCount: number;
  locationsWithoutRatesCount: number;
  groups: { id: string; zones: Zone[] }[];
  memberships: Record<string, string[]>;
  sellingPlans: boolean;
}
export interface Product {
  id: string;
  updatedAt: string;
  variants: string[];
  // Only positive provider facts may satisfy coversAllItems' shippable subset.
  shippableVariants?: string[];
}
export interface MarketRate {
  id: string;
  price: Money;
  minValue?: Money;
  maxValue?: Money | null;
  transitTimeMinSeconds: number | null;
  transitTimeMaxSeconds: number | null;
}
export interface MarketOption {
  id: string;
  kind: "FLAT" | "VALUE" | "WEIGHT" | "CARRIER" | "UNKNOWN";
  active: boolean;
  currency: string;
  freeMinimum: Money | null;
  // Exactly one rate group without collection or origin-location conditions.
  // Only that group applies the same rates to every shippable item.
  uniform: boolean;
  // Null when cart-value tiers exceed one bounded page.
  rates: MarketRate[] | null;
}
export interface MarketRegion {
  id: string;
  country: string;
  subdivision: string | null;
}
export interface Market {
  id: string;
  type: string;
  status: string;
  conditionTypes: string[];
  allRegions: boolean;
  regions: MarketRegion[];
  // Null inherits from the parent market; a root market inherits no shipping.
  shipping: { enabled: boolean; options: MarketOption[] } | null;
}
export interface Acquisition {
  profiles: Record<string, Profile>;
  products: Record<string, Product>;
  // Present only for market-driven shops, whose merchant shipping lives in
  // Markets. Their legacy delivery profiles are never read.
  markets?: Record<string, Market>;
  acquiredAt: string;
}
export interface MappedProfile {
  objectKey: string;
  providerId: string;
  isDefault: boolean;
  content: ShippingProfileContentData;
}
export interface MappedMembership {
  sourceListingId: string;
  profileObjectKey: string | null;
  variants: string[] | null;
}
export interface Mapping {
  profiles: MappedProfile[];
  memberships: MappedMembership[];
  limitations: string[];
}

// Region markets resolve online shoppers by destination, so they decide the
// options of buyers who check out from Aura Historia. Company-location and
// retail-location markets serve B2B and POS buyers.
export function isRegionMarket(market: Market) {
  return (
    market.status === "ACTIVE" &&
    market.type === "REGION" &&
    market.conditionTypes.join() === "REGION"
  );
}

export function profileObjectKey(id: string) {
  if (!/^gid:\/\/shopify\/DeliveryProfile\/\d+$/.test(id)) {
    throw new ShippingReadError("INVALID_PROFILE_ID");
  }
  return `shopify:delivery-profile:${id.split("/").at(-1)}`;
}

export function sourceProductId(id: string) {
  if (!/^gid:\/\/shopify\/Product\/\d+$/.test(id)) {
    throw new ShippingReadError("INVALID_PRODUCT_ID");
  }
  // Catalog ingestion and backfill both use the numeric source identity.
  return id.split("/").at(-1) as string;
}
