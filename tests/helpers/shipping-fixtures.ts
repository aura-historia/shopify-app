import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { GraphqlRequestFn } from "../../app/backfill.server";
import type { Acquisition, Connection } from "../../app/shipping/model";
export const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/shopify-shipping-2026-10.json", import.meta.url),
    "utf8",
  ),
) as Acquisition;
// Mirrors the backend's import preparation (shipping-postgres imports.rs):
// only profile creation carries the stable object key, and creation needs it.
export function importIdentityRejection(
  method: string,
  path: string,
  body: { import?: { objectKey?: unknown } } | null,
) {
  if (!body?.import) return undefined;
  const create = method === "POST" && path.endsWith("/shipping-profiles");
  if (create === (body.import.objectKey != null)) return undefined;
  return Response.json(
    {
      status: 400,
      title: "Bad Request",
      error: "BAD_BODY_VALUE",
      detail: "Invalid advertised shipping input.",
    },
    { status: 400 },
  );
}

// Mirrors the backend's listing-delivery lookup (partner_product_listings/
// delivery.rs) for a source listing that catalog ingestion has not created.
export function missingListingProblem() {
  return Response.json(
    { status: 404, title: "Not Found", error: "PRODUCT_LISTING_NOT_FOUND" },
    { status: 404, headers: { "Content-Type": "application/problem+json" } },
  );
}

function page<T>(nodes: T[], after: unknown): Connection<T> {
  const start = after ? Number(after) : 0;
  return {
    nodes: nodes.slice(start, start + 1),
    pageInfo: {
      hasNextPage: start + 1 < nodes.length,
      endCursor: String(start + 1),
    },
  };
}

// Shopify rejects declared variables that the operation never references.
// Check the actual generated documents before returning fixture data.
function operation(query: string) {
  const declarations = query.slice(0, query.indexOf("{"));
  const selection = query.slice(query.indexOf("{"));
  for (const [variable] of declarations.matchAll(/\$\w+/g)) {
    assert.ok(selection.includes(variable), `Unused variable ${variable}`);
  }
  // Shipping reads Shopify only. A mutation would change merchant settings.
  assert.match(query.trimStart(), /^query \w+/);
  return /query (\w+)/.exec(query)?.[1] ?? "";
}

export function fixtureGraphql(snapshot = structuredClone(fixture)) {
  const calls: { name: string; variables: Record<string, unknown> }[] = [];
  const request: GraphqlRequestFn = async (query, variables) => {
    const name = operation(query);
    calls.push({ name, variables });
    if (name === "ShippingModel")
      return { data: { shop: { features: { marketDrivenShipping: false } } } };
    if (name === "ShippingPreflight")
      return {
        data: {
          currentAppInstallation: {
            accessScopes: [{ handle: "read_shipping" }],
          },
          shop: { features: { marketDrivenShipping: false } },
          method: {
            fields: [{ name: "rateProvider" }, { name: "methodConditions" }],
          },
        },
      };
    if (name === "ShippingProfiles")
      return {
        data: {
          deliveryProfiles: page(
            Object.values(snapshot.profiles).map((p) => ({
              ...p,
              profileLocationGroups: p.groups.map((g) => ({
                locationGroup: { id: g.id },
              })),
              sellingPlanGroups: {
                nodes: p.sellingPlans ? [{ id: "plan" }] : [],
              },
            })),
            variables.after,
          ),
        },
      };
    if (name === "ShippingProducts")
      return {
        data: {
          products: page(
            Object.values(snapshot.products).map((p) => ({
              id: p.id,
              updatedAt: p.updatedAt,
            })),
            variables.after,
          ),
        },
      };
    if (name === "ShippingVariants" || name === "ShippingVerifyProduct") {
      const product = snapshot.products[String(variables.id)];
      return {
        data: {
          product: product
            ? {
                ...product,
                variants: page(
                  product.variants.map((id) => ({
                    id,
                    inventoryItem: {
                      requiresShipping:
                        product.shippableVariants?.includes(id) === true,
                    },
                  })),
                  variables.after,
                ),
              }
            : null,
        },
      };
    }
    if (name === "ShippingMembershipVariants") {
      const [profile, product] = String(variables.id).split("|");
      return {
        data: {
          node: {
            variants: page(
              snapshot.profiles[profile].memberships[product].map((id) => ({
                id,
              })),
              variables.after,
            ),
          },
        },
      };
    }
    const profile = snapshot.profiles[String(variables.id)];
    if (name === "ShippingItems")
      return {
        data: {
          deliveryProfile: {
            version: profile.version,
            profileItems: page(
              Object.keys(profile.memberships).map((product) => ({
                id: `${profile.id}|${product}`,
                product: { id: product },
              })),
              variables.after,
            ),
          },
        },
      };
    if (name === "ShippingZones") {
      const group = profile.groups.find((g) => g.id === variables.group);
      assert.ok(group);
      const zones = page(group.zones, variables.zoneAfter);
      return {
        data: {
          deliveryProfile: {
            version: profile.version,
            profileLocationGroups: [
              {
                locationGroup: { id: group.id },
                locationGroupZones: {
                  ...zones,
                  nodes: zones.nodes.map((zone) => ({
                    zone: { id: zone.id, countries: zone.countries },
                    methodDefinitions: page(zone.methods, variables.after),
                  })),
                },
              },
            ],
          },
        },
      };
    }
    throw new Error(`Unexpected fixture operation ${name}`);
  };
  return { request, calls, snapshot };
}

export interface RawMarket {
  id: string;
  name: string;
  type: string;
  status: string;
  conditions: {
    conditionTypes: string[];
    regionsCondition: { applicationLevel: string } | null;
  } | null;
  regions: Record<string, unknown>[];
  shipping: {
    isEnabled: boolean;
    optionDefinitions: Record<string, unknown>[];
  } | null;
}
// Synthetic markets in the 2026-10 response shape, including the aliases the
// importer selects. Values are not recorded from a live shop.
export const marketFixture = JSON.parse(
  readFileSync(
    new URL(
      "../fixtures/shopify-market-shipping-2026-10.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  evidence: Record<string, unknown> & {
    requiredScope: string;
    webhookTopics: string[];
    webhookPayload: Record<string, unknown>;
  };
  markets: RawMarket[];
};

export function marketGraphql(
  markets = structuredClone(marketFixture.markets),
  products = structuredClone(fixture.products),
) {
  const controls = { scopes: ["read_markets"], marketDriven: true };
  // Product traversal is shared with the profile model.
  const catalog = fixtureGraphql({
    profiles: {},
    products,
    acquiredAt: fixture.acquiredAt,
  });
  const calls = catalog.calls;
  const market = (id: unknown) => {
    const found = markets.find((candidate) => candidate.id === id);
    return found ? { ...found } : null;
  };
  // Like a decoded response, returned data never aliases the fixture state.
  const request: GraphqlRequestFn = async (query, variables) =>
    structuredClone(await respond(query, variables));
  const respond: GraphqlRequestFn = async (query, variables) => {
    const name = operation(query);
    if (name === "ShippingProducts" || /^ShippingV/.test(name))
      return catalog.request(query, variables);
    calls.push({ name, variables });
    if (name === "ShippingModel")
      return {
        data: {
          shop: { features: { marketDrivenShipping: controls.marketDriven } },
        },
      };
    if (name === "ShippingPreflight")
      return {
        data: {
          currentAppInstallation: {
            accessScopes: controls.scopes.map((handle) => ({ handle })),
          },
          shop: { features: { marketDrivenShipping: controls.marketDriven } },
          method: {
            fields: [{ name: "rateProvider" }, { name: "methodConditions" }],
          },
          shipping: {
            fields: [{ name: "isEnabled" }, { name: "optionDefinitions" }],
          },
        },
      };
    if (name === "ShippingMarkets")
      return {
        data: {
          markets: page(
            markets.map((node) => ({
              id: node.id,
              type: node.type,
              status: node.status,
              conditions: node.conditions,
              delivery: {
                shipping: node.shipping
                  ? { isEnabled: node.shipping.isEnabled }
                  : null,
              },
            })),
            variables.after,
          ),
        },
      };
    const node = market(variables.id);
    if (name === "ShippingMarketRegions")
      return {
        data: {
          market: node && {
            conditions: node.conditions && {
              regionsCondition: node.conditions.regionsCondition && {
                regions: page(node.regions, variables.after),
              },
            },
          },
        },
      };
    if (name === "ShippingMarketOptions") {
      assert.equal(variables.first, 5);
      return {
        data: {
          market: node && {
            delivery: {
              shipping: node.shipping && {
                isEnabled: node.shipping.isEnabled,
                optionDefinitions: page(
                  node.shipping.optionDefinitions,
                  variables.after,
                ),
              },
            },
          },
        },
      };
    }
    // Legacy delivery profiles never stand in for market configuration.
    throw new Error(`Unexpected market-driven operation ${name}`);
  };
  return { request, calls, markets, products, controls };
}
