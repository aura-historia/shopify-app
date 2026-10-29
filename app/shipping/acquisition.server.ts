import type { GraphqlRequestFn } from "../backfill.server";
import {
  type Acquisition,
  type Connection,
  type Country,
  isRegionMarket,
  type Market,
  type MarketOption,
  type MarketRate,
  type MarketRegion,
  type Method,
  type Money,
  type Profile,
  SHIPPING_LIMITS,
  ShippingReadError,
} from "./model";

const PAGE = "pageInfo { hasNextPage endCursor }";
const PROFILE = `id name version default coversAllItems originLocationCount locationsWithoutRatesCount
  sellingPlanGroups(first: 1) { nodes { id } }
  profileLocationGroups { locationGroup { id } }`;
const MARKET = `id type status conditions { conditionTypes regionsCondition { applicationLevel } }
  delivery { shipping { isEnabled } }`;
const MONEY = "amount currencyCode";
const TRANSIT = "transitTimeMinSeconds transitTimeMaxSeconds";
const GROUP =
  "id conditions { collectionsCount { count } originLocationsCount { count } }";
// A second rate group always varies rates by collection or origin location,
// so one group per option decides whether its rates are uniform.
const OPTION = `__typename id isActive currency freeDeliveryMinimumValue { ${MONEY} }
  ... on DeliveryFlatRateOptionDefinition { flatGroups: rateGroups(first: 1) {
    nodes { ${GROUP} rate { id price { ${MONEY} } ${TRANSIT} } } ${PAGE} } }
  ... on DeliveryValueBasedOptionDefinition { valueGroups: rateGroups(first: 1) {
    nodes { ${GROUP} rates(first: ${SHIPPING_LIMITS.rateTiers}) {
      nodes { id price { ${MONEY} } minValue { ${MONEY} } maxValue { ${MONEY} } ${TRANSIT} } ${PAGE} } } ${PAGE} } }
  ... on DeliveryWeightBasedOptionDefinition { weightGroups: rateGroups(first: 1) { nodes { ${GROUP} } ${PAGE} } }
  ... on DeliveryCarrierCalculatedOptionDefinition { carrierGroups: rateGroups(first: 1) { nodes { ${GROUP} } ${PAGE} } }`;
const OPTION_KINDS: Record<string, MarketOption["kind"]> = {
  DeliveryFlatRateOptionDefinition: "FLAT",
  DeliveryValueBasedOptionDefinition: "VALUE",
  DeliveryWeightBasedOptionDefinition: "WEIGHT",
  DeliveryCarrierCalculatedOptionDefinition: "CARRIER",
};
type PagedTask<K extends string> = {
  [Kind in K]: { kind: Kind; after?: string };
}[K];
export type ReadTask =
  | { kind: "preflight" }
  | PagedTask<"profiles" | "verifyProfiles" | "products">
  | { kind: "zones"; profile: string; group: string; after?: string }
  | {
      kind: "methods";
      profile: string;
      group: string;
      zone: string;
      zoneAfter?: string;
      after?: string;
    }
  | { kind: "items"; profile: string; after?: string }
  | {
      kind: "membershipVariants";
      profile: string;
      item: string;
      product: string;
      after?: string;
    }
  | (PagedTask<"variants" | "verifyProduct"> & { product: string })
  // A verifying market read rebuilds the configuration for comparison.
  | { kind: "markets"; after?: string; verify?: boolean }
  | {
      [Kind in "marketRegions" | "marketOptions"]: {
        kind: Kind;
        market: string;
        after?: string;
        verify?: boolean;
      };
    }["marketRegions" | "marketOptions"];

export interface ShippingAcquisitionState {
  tasks: ReadTask[];
  snapshot: Acquisition;
  pages: number;
  verifiedProfiles: string[];
  verifiedMarkets?: Record<string, Market>;
  verifying: boolean;
}

export function beginAcquisition(now: string): ShippingAcquisitionState {
  return {
    // The preflight selects the shop's shipping model before reading it.
    tasks: [{ kind: "preflight" }, { kind: "products" }],
    snapshot: { profiles: {}, products: {}, acquiredAt: now },
    pages: 0,
    verifiedProfiles: [],
    verifying: false,
  };
}

function nextPage<T>(
  connection: Connection<T>,
  task: Exclude<ReadTask, { kind: "preflight" }>,
  state: ShippingAcquisitionState,
) {
  if (
    !connection ||
    !Array.isArray(connection.nodes) ||
    !connection.pageInfo ||
    typeof connection.pageInfo.hasNextPage !== "boolean"
  ) {
    throw new ShippingReadError("INCOMPLETE_SHOPIFY_PAGE");
  }
  if (connection.pageInfo.hasNextPage) {
    const after = connection.pageInfo.endCursor;
    if (!after || ("after" in task && task.after === after)) {
      throw new ShippingReadError("INVALID_SHOPIFY_CURSOR");
    }
    state.tasks.push({ ...task, after });
  }
  return connection.nodes;
}

async function read<T>(
  graphql: GraphqlRequestFn,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const body = (await graphql(query, variables)) as {
    data?: T;
    errors?: { extensions?: { code?: string } }[];
  };
  if (body.errors?.length || !body.data) {
    throw new ShippingReadError(
      body.errors?.some((e) => e.extensions?.code === "ACCESS_DENIED")
        ? "SHIPPING_PERMISSION_REQUIRED"
        : "SHOPIFY_READ_FAILED",
    );
  }
  return body.data;
}

function checkVersion(profile: Profile, version: number) {
  if (profile.version !== version)
    throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
}

type RawRate = Omit<
  MarketRate,
  "transitTimeMinSeconds" | "transitTimeMaxSeconds"
> & {
  transitTimeMinSeconds?: number | null;
  transitTimeMaxSeconds?: number | null;
};
type RawRateGroup = {
  id: string;
  conditions: {
    collectionsCount: { count: number } | null;
    originLocationsCount: { count: number } | null;
  };
  rate?: RawRate | null;
  rates?: Connection<RawRate>;
};
type RawOption = {
  __typename: string;
  id: string;
  isActive: boolean;
  currency: string;
  freeDeliveryMinimumValue: Money | null;
} & Partial<
  Record<
    "flatGroups" | "valueGroups" | "weightGroups" | "carrierGroups",
    Connection<RawRateGroup> | null
  >
>;
type RawRegion = {
  __typename: string;
  id: string;
  code?: string;
  country?: { code: string };
};

function complete<T>(connection: Connection<T>) {
  if (
    !Array.isArray(connection?.nodes) ||
    typeof connection.pageInfo?.hasNextPage !== "boolean"
  )
    throw new ShippingReadError("INCOMPLETE_SHOPIFY_PAGE");
  return connection;
}

function marketRate(rate: RawRate): MarketRate {
  return {
    id: rate.id,
    price: rate.price,
    ...(rate.minValue
      ? { minValue: rate.minValue, maxValue: rate.maxValue ?? null }
      : {}),
    transitTimeMinSeconds: rate.transitTimeMinSeconds ?? null,
    transitTimeMaxSeconds: rate.transitTimeMaxSeconds ?? null,
  };
}

function marketOption(option: RawOption): MarketOption {
  const kind = OPTION_KINDS[option.__typename] ?? "UNKNOWN";
  const groups =
    option.flatGroups ??
    option.valueGroups ??
    option.weightGroups ??
    option.carrierGroups;
  const nodes = groups ? complete(groups).nodes : [];
  const group =
    nodes.length === 1 && !groups?.pageInfo.hasNextPage ? nodes[0] : undefined;
  let rates: MarketRate[] | null = [];
  if (group?.rate) rates = [marketRate(group.rate)];
  else if (group?.rates)
    rates = complete(group.rates).pageInfo.hasNextPage
      ? null
      : group.rates.nodes.map(marketRate);
  return {
    id: option.id,
    kind,
    active: option.isActive === true,
    currency: option.currency,
    freeMinimum: option.freeDeliveryMinimumValue ?? null,
    // Conditions narrow a rate group only where present: no collection
    // condition applies to all products, no origin location to all origins.
    uniform:
      kind !== "UNKNOWN" &&
      group !== undefined &&
      group.conditions.collectionsCount === null &&
      group.conditions.originLocationsCount?.count === 0,
    rates,
  };
}

function marketRegion(region: RawRegion): MarketRegion {
  if (region.__typename === "MarketRegionCountry" && region.code)
    return { id: region.id, country: region.code, subdivision: null };
  if (
    region.__typename === "MarketRegionSubdivision" &&
    region.code &&
    region.country?.code
  )
    return {
      id: region.id,
      country: region.country.code,
      subdivision: region.code,
    };
  throw new ShippingReadError("UNSUPPORTED_SHOPIFY_SCHEMA");
}

function marketsFor(state: ShippingAcquisitionState, verify?: boolean) {
  if (verify) {
    state.verifiedMarkets ??= {};
    return state.verifiedMarkets;
  }
  state.snapshot.markets ??= {};
  return state.snapshot.markets;
}

type ProfileHeader = Omit<
  Profile,
  "groups" | "memberships" | "sellingPlans"
> & {
  profileLocationGroups: { locationGroup: { id: string } }[];
  sellingPlanGroups: { nodes: { id: string }[] };
};

// One bounded provider request per step; the caller persists after every step.
// The same state machine is used by initial, manual and future S02 wake-ups.
export async function acquireShippingStep(
  state: ShippingAcquisitionState,
  graphql: GraphqlRequestFn,
) {
  const task = state.tasks.shift();
  if (!task) return;
  if (++state.pages > SHIPPING_LIMITS.pages)
    throw new ShippingReadError("ACQUISITION_LIMIT_EXCEEDED");
  const variables = {
    ...("after" in task ? { after: task.after ?? null } : {}),
    first: SHIPPING_LIMITS.pageSize,
  };
  if (task.kind === "preflight") {
    type Fields = { fields: { name: string }[] } | null;
    const data = await read<{
      currentAppInstallation: { accessScopes: { handle: string }[] };
      shop: { features: { marketDrivenShipping: boolean } };
      method: Fields;
      shipping: Fields;
    }>(
      graphql,
      `query ShippingPreflight {
      currentAppInstallation { accessScopes { handle } }
      shop { features { marketDrivenShipping } }
      method: __type(name: "DeliveryMethodDefinition") { fields { name } }
      shipping: __type(name: "ShippingConfiguration") { fields { name } }
    }`,
    );
    const granted = (...handles: string[]) =>
      data.currentAppInstallation.accessScopes.some((scope) =>
        handles.includes(scope.handle),
      );
    const exposes = (type: Fields, ...names: string[]) =>
      names.every((name) => type?.fields.some((field) => field.name === name));
    const marketDriven = data.shop.features.marketDrivenShipping;
    if (marketDriven === true) {
      // Merchant shipping lives in Markets. The legacy delivery profiles of
      // such a shop can be a stale snapshot and never stand in for it.
      if (!granted("read_markets", "write_markets"))
        throw new ShippingReadError("SHIPPING_PERMISSION_REQUIRED");
      if (!exposes(data.shipping, "isEnabled", "optionDefinitions"))
        throw new ShippingReadError("UNSUPPORTED_SHOPIFY_SCHEMA");
      state.snapshot.markets = {};
    } else if (marketDriven === false) {
      if (!granted("read_shipping", "write_shipping"))
        throw new ShippingReadError("SHIPPING_PERMISSION_REQUIRED");
      if (!exposes(data.method, "rateProvider", "methodConditions"))
        throw new ShippingReadError("UNSUPPORTED_SHOPIFY_SCHEMA");
      delete state.snapshot.markets;
    } else throw new ShippingReadError("UNSUPPORTED_SHOPIFY_SCHEMA");
    // Acquisitions persisted before the model check queued profile reads.
    state.tasks = state.tasks.filter((queued) => queued.kind !== "profiles");
    state.tasks.unshift(
      marketDriven ? { kind: "markets" } : { kind: "profiles" },
    );
  } else if (task.kind === "markets") {
    const data = await read<{
      markets: Connection<{
        id: string;
        type: string;
        status: string;
        conditions: {
          conditionTypes: string[];
          regionsCondition: { applicationLevel: string | null } | null;
        } | null;
        delivery: { shipping: { isEnabled: boolean } | null } | null;
      }>;
    }>(
      graphql,
      `query ShippingMarkets($first: Int!, $after: String) {
        markets(first: $first, after: $after, sortKey: ID) { nodes { ${MARKET} } ${PAGE} }
      }`,
      variables,
    );
    const markets = marketsFor(state, task.verify);
    for (const node of nextPage(data.markets, task, state)) {
      if (!/^gid:\/\/shopify\/Market\/\d+$/.test(node.id))
        throw new ShippingReadError("INVALID_MARKET_ID");
      if (markets[node.id])
        throw new ShippingReadError("DUPLICATE_PROVIDER_OBJECT");
      if (!node.delivery)
        throw new ShippingReadError("INCOMPLETE_SHOPIFY_PAGE");
      const shipping = node.delivery.shipping;
      const market: Market = {
        id: node.id,
        type: node.type,
        status: node.status,
        conditionTypes: [...(node.conditions?.conditionTypes ?? [])].sort(),
        allRegions:
          node.conditions?.regionsCondition?.applicationLevel === "ALL",
        regions: [],
        shipping: shipping
          ? { enabled: shipping.isEnabled === true, options: [] }
          : null,
      };
      markets[market.id] = market;
      if (!isRegionMarket(market)) continue;
      const verify = task.verify ? { verify: true } : {};
      if (!market.allRegions)
        state.tasks.push({
          kind: "marketRegions",
          market: market.id,
          ...verify,
        });
      if (market.shipping?.enabled)
        state.tasks.push({
          kind: "marketOptions",
          market: market.id,
          ...verify,
        });
    }
    if (Object.keys(markets).length > SHIPPING_LIMITS.markets)
      throw new ShippingReadError("ACQUISITION_LIMIT_EXCEEDED");
  } else if (task.kind === "marketRegions") {
    const market = marketsFor(state, task.verify)[task.market];
    const data = await read<{
      market: {
        conditions: {
          regionsCondition: { regions: Connection<RawRegion> } | null;
        } | null;
      } | null;
    }>(
      graphql,
      `query ShippingMarketRegions($id: ID!, $first: Int!, $after: String) {
        market(id: $id) { conditions { regionsCondition { regions(first: $first, after: $after) {
          nodes { __typename id ... on MarketRegionCountry { code } ... on MarketRegionSubdivision { code country { code } } } ${PAGE}
        } } } }
      }`,
      { ...variables, id: task.market },
    );
    const regions = data.market?.conditions?.regionsCondition?.regions;
    if (!market || !regions)
      throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
    for (const node of nextPage(regions, task, state)) {
      if (market.regions.some((region) => region.id === node.id))
        throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
      market.regions.push(marketRegion(node));
    }
  } else if (task.kind === "marketOptions") {
    const market = marketsFor(state, task.verify)[task.market];
    const data = await read<{
      market: {
        delivery: {
          shipping: {
            isEnabled: boolean;
            optionDefinitions: Connection<RawOption>;
          } | null;
        };
      } | null;
    }>(
      graphql,
      `query ShippingMarketOptions($id: ID!, $first: Int!, $after: String) {
        market(id: $id) { delivery { shipping { isEnabled
          optionDefinitions(first: $first, after: $after) { nodes { ${OPTION} } ${PAGE} }
        } } }
      }`,
      { ...variables, first: SHIPPING_LIMITS.optionPageSize, id: task.market },
    );
    const shipping = data.market?.delivery?.shipping;
    if (
      !market?.shipping ||
      !shipping ||
      shipping.isEnabled !== market.shipping.enabled
    )
      throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
    for (const node of nextPage(shipping.optionDefinitions, task, state)) {
      if (market.shipping.options.some((option) => option.id === node.id))
        throw new ShippingReadError("DUPLICATE_PROVIDER_OBJECT");
      market.shipping.options.push(marketOption(node));
    }
  } else if (task.kind === "profiles" || task.kind === "verifyProfiles") {
    const data = await read<{ deliveryProfiles: Connection<ProfileHeader> }>(
      graphql,
      `query ShippingProfiles($first: Int!, $after: String) {
        deliveryProfiles(first: $first, after: $after) { nodes { ${PROFILE} } ${PAGE} }
      }`,
      variables,
    );
    for (const header of nextPage(data.deliveryProfiles, task, state)) {
      if (task.kind === "verifyProfiles") {
        const profile = state.snapshot.profiles[header.id];
        if (!profile || state.verifiedProfiles.includes(header.id))
          throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
        checkVersion(profile, header.version);
        state.verifiedProfiles.push(header.id);
        continue;
      }
      if (state.snapshot.profiles[header.id])
        throw new ShippingReadError("DUPLICATE_PROVIDER_OBJECT");
      const profile: Profile = {
        ...header,
        groups: header.profileLocationGroups.map((group) => ({
          id: group.locationGroup.id,
          zones: [],
        })),
        memberships: {},
        sellingPlans: header.sellingPlanGroups.nodes.length > 0,
      };
      state.snapshot.profiles[profile.id] = profile;
      for (const group of profile.groups)
        state.tasks.push({
          kind: "zones",
          profile: profile.id,
          group: group.id,
        });
      state.tasks.push({ kind: "items", profile: profile.id });
    }
    if (Object.keys(state.snapshot.profiles).length > SHIPPING_LIMITS.profiles)
      throw new ShippingReadError("ACQUISITION_LIMIT_EXCEEDED");
  } else if (task.kind === "products") {
    const data = await read<{
      products: Connection<{ id: string; updatedAt: string }>;
    }>(
      graphql,
      `query ShippingProducts($first: Int!, $after: String) {
        products(first: $first, after: $after, sortKey: ID) { nodes { id updatedAt } ${PAGE} }
      }`,
      variables,
    );
    for (const product of nextPage(data.products, task, state)) {
      if (state.snapshot.products[product.id])
        throw new ShippingReadError("DUPLICATE_PROVIDER_OBJECT");
      state.snapshot.products[product.id] = {
        ...product,
        variants: [],
        shippableVariants: [],
      };
      state.tasks.push({ kind: "variants", product: product.id });
    }
    if (Object.keys(state.snapshot.products).length > SHIPPING_LIMITS.products)
      throw new ShippingReadError("ACQUISITION_LIMIT_EXCEEDED");
  } else if (task.kind === "variants" || task.kind === "verifyProduct") {
    const data = await read<{
      product: {
        id: string;
        updatedAt: string;
        variants?: Connection<{
          id: string;
          inventoryItem: { requiresShipping: boolean };
        }>;
      } | null;
    }>(
      graphql,
      task.kind === "variants"
        ? `query ShippingVariants($id: ID!, $first: Int!, $after: String) { product(id: $id) { id updatedAt variants(first: $first, after: $after) { nodes { id inventoryItem { requiresShipping } } ${PAGE} } } }`
        : `query ShippingVerifyProduct($id: ID!) { product(id: $id) { id updatedAt } }`,
      { ...variables, id: task.product },
    );
    const product = state.snapshot.products[task.product];
    if (!data.product || data.product.updatedAt !== product.updatedAt)
      throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
    if (task.kind === "variants") {
      const variants = nextPage(
        data.product.variants as NonNullable<typeof data.product.variants>,
        task,
        state,
      );
      product.variants.push(...variants.map((v) => v.id));
      product.shippableVariants ??= [];
      product.shippableVariants.push(
        ...variants
          .filter((v) => v.inventoryItem?.requiresShipping === true)
          .map((v) => v.id),
      );
      if (new Set(product.variants).size !== product.variants.length)
        throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
    }
  } else if (task.kind === "membershipVariants") {
    const data = await read<{
      node: { variants: Connection<{ id: string }> } | null;
    }>(
      graphql,
      `query ShippingMembershipVariants($id: ID!, $first: Int!, $after: String) {
        node(id: $id) { ... on DeliveryProfileItem { variants(first: $first, after: $after) { nodes { id } ${PAGE} } } }
      }`,
      { ...variables, id: task.item },
    );
    if (!data.node) throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
    const variants =
      state.snapshot.profiles[task.profile].memberships[task.product];
    variants.push(
      ...nextPage(data.node.variants, task, state).map((v) => v.id),
    );
    if (new Set(variants).size !== variants.length)
      throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
  } else {
    const profile = state.snapshot.profiles[task.profile];
    if (task.kind === "items") {
      const data = await read<{
        deliveryProfile: {
          version: number;
          profileItems: Connection<{ id: string; product: { id: string } }>;
        } | null;
      }>(
        graphql,
        `query ShippingItems($id: ID!, $first: Int!, $after: String) { deliveryProfile(id: $id) {
          version profileItems(first: $first, after: $after) { nodes { id product { id } } ${PAGE} }
        } }`,
        { ...variables, id: task.profile },
      );
      if (!data.deliveryProfile)
        throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
      checkVersion(profile, data.deliveryProfile.version);
      for (const item of nextPage(
        data.deliveryProfile.profileItems,
        task,
        state,
      )) {
        if (profile.memberships[item.product.id])
          throw new ShippingReadError("DUPLICATE_PROVIDER_OBJECT");
        profile.memberships[item.product.id] = [];
        state.tasks.push({
          kind: "membershipVariants",
          profile: profile.id,
          item: item.id,
          product: item.product.id,
        });
      }
    } else {
      const methodFields = `id name active methodConditions { field operator conditionCriteria {
        __typename ... on MoneyV2 { amount currencyCode } ... on Weight { value unit }
      } } rateProvider { __typename ... on DeliveryRateDefinition { id price { amount currencyCode } } ... on DeliveryParticipant { id } }`;
      const data = await read<{
        deliveryProfile: {
          version: number;
          profileLocationGroups: {
            locationGroup: { id: string };
            locationGroupZones: Connection<{
              zone: { id: string; countries: Country[] };
              methodDefinitions?: Connection<Method>;
            }>;
          }[];
        } | null;
      }>(
        graphql,
        `query ShippingZones($id: ID!, $group: ID!, $zoneAfter: String${task.kind === "methods" ? ", $after: String, $first: Int!" : ""}) {
        deliveryProfile(id: $id) { version profileLocationGroups(locationGroupId: $group) {
          locationGroup { id } locationGroupZones(first: 1, after: $zoneAfter) {
            nodes { zone { id countries { code { countryCode restOfWorld } provinces { code } } }
              ${task.kind === "methods" ? `methodDefinitions(first: $first, after: $after) { nodes { ${methodFields} } ${PAGE} }` : ""}
            } ${PAGE}
          }
        } }
      }`,
        {
          id: profile.id,
          group: task.group,
          zoneAfter:
            task.kind === "zones"
              ? (task.after ?? null)
              : (task.zoneAfter ?? null),
          after: task.kind === "methods" ? (task.after ?? null) : null,
          first: SHIPPING_LIMITS.pageSize,
        },
      );
      if (!data.deliveryProfile)
        throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
      checkVersion(profile, data.deliveryProfile.version);
      const group = data.deliveryProfile.profileLocationGroups.find(
        (g) => g.locationGroup.id === task.group,
      );
      const target = profile.groups.find((g) => g.id === task.group);
      if (!group || !target)
        throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
      if (task.kind === "zones") {
        for (const node of nextPage(group.locationGroupZones, task, state)) {
          target.zones.push({ ...node.zone, methods: [] });
          state.tasks.push({
            kind: "methods",
            profile: profile.id,
            group: target.id,
            zone: node.zone.id,
            zoneAfter: task.after,
          });
        }
      } else {
        const node = group.locationGroupZones.nodes[0];
        const zone = target.zones.find((z) => z.id === task.zone);
        if (!node || node.zone.id !== task.zone || !zone)
          throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
        zone.methods.push(
          ...nextPage(
            node.methodDefinitions as Connection<Method>,
            task,
            state,
          ),
        );
      }
    }
  }
  if (state.tasks.length === 0 && !state.verifying) {
    state.verifying = true;
    // Markets have no version. A second complete read must reproduce them.
    if (state.snapshot.markets) state.verifiedMarkets = {};
    state.tasks.push(
      state.snapshot.markets
        ? { kind: "markets", verify: true }
        : { kind: "verifyProfiles" },
      ...Object.keys(state.snapshot.products).map(
        (product): ReadTask => ({ kind: "verifyProduct", product }),
      ),
    );
  }
  if (
    state.tasks.length === 0 &&
    (state.verifiedProfiles.length !==
      Object.keys(state.snapshot.profiles).length ||
      (state.snapshot.markets &&
        JSON.stringify(state.verifiedMarkets) !==
          JSON.stringify(state.snapshot.markets)))
  ) {
    throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
  }
  if (
    new TextEncoder().encode(JSON.stringify(state)).byteLength >
    SHIPPING_LIMITS.bytes
  )
    throw new ShippingReadError("ACQUISITION_LIMIT_EXCEEDED");
}
