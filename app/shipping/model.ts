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
  products: 5000,
  variants: 64,
  bytes: 4_000_000,
} as const;

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
}
export interface Acquisition {
  profiles: Record<string, Profile>;
  products: Record<string, Product>;
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
