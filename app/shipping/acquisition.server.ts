import type { GraphqlRequestFn } from "../backfill.server";
import {
  type Acquisition,
  type Connection,
  type Country,
  type Method,
  type Profile,
  SHIPPING_LIMITS,
  ShippingReadError,
} from "./model";

const PAGE = "pageInfo { hasNextPage endCursor }";
const PROFILE = `id name version default coversAllItems originLocationCount locationsWithoutRatesCount
  sellingPlanGroups(first: 1) { nodes { id } }
  profileLocationGroups { locationGroup { id } }`;
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
  | (PagedTask<"variants" | "verifyProduct"> & { product: string });

export interface ShippingAcquisitionState {
  tasks: ReadTask[];
  snapshot: Acquisition;
  pages: number;
  verifiedProfiles: string[];
  verifying: boolean;
}

export function beginAcquisition(now: string): ShippingAcquisitionState {
  return {
    tasks: [{ kind: "preflight" }, { kind: "profiles" }, { kind: "products" }],
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
    const data = await read<{
      currentAppInstallation: { accessScopes: { handle: string }[] };
      shop: { features: { marketDrivenShipping: boolean } };
      method: { fields: { name: string }[] };
    }>(
      graphql,
      `query ShippingPreflight {
      currentAppInstallation { accessScopes { handle } }
      shop { features { marketDrivenShipping } }
      method: __type(name: "DeliveryMethodDefinition") { fields { name } }
    }`,
    );
    if (
      !data.currentAppInstallation.accessScopes.some(
        (scope) =>
          scope.handle === "read_shipping" || scope.handle === "write_shipping",
      )
    ) {
      throw new ShippingReadError("SHIPPING_PERMISSION_REQUIRED");
    }
    if (data.shop.features.marketDrivenShipping !== false) {
      throw new ShippingReadError("MARKET_DRIVEN_SHIPPING_UNSUPPORTED");
    }
    if (
      !data.method?.fields.some((f) => f.name === "rateProvider") ||
      !data.method.fields.some((f) => f.name === "methodConditions")
    ) {
      throw new ShippingReadError("UNSUPPORTED_SHOPIFY_SCHEMA");
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
    state.tasks.push(
      { kind: "verifyProfiles" },
      ...Object.keys(state.snapshot.products).map(
        (product): ReadTask => ({ kind: "verifyProduct", product }),
      ),
    );
  }
  if (
    state.tasks.length === 0 &&
    state.verifiedProfiles.length !==
      Object.keys(state.snapshot.profiles).length
  ) {
    throw new ShippingReadError("SHOPIFY_CHANGED_DURING_READ");
  }
  if (
    new TextEncoder().encode(JSON.stringify(state)).byteLength >
    SHIPPING_LIMITS.bytes
  )
    throw new ShippingReadError("ACQUISITION_LIMIT_EXCEEDED");
}
