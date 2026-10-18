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

export function fixtureGraphql(snapshot = structuredClone(fixture)) {
  const calls: { name: string; variables: Record<string, unknown> }[] = [];
  const request: GraphqlRequestFn = async (query, variables) => {
    // Shopify rejects declared variables that the operation never references.
    // Check the actual generated documents before returning fixture data.
    const declarations = query.slice(0, query.indexOf("{"));
    const selection = query.slice(query.indexOf("{"));
    for (const [variable] of declarations.matchAll(/\$\w+/g)) {
      assert.ok(selection.includes(variable), `Unused variable ${variable}`);
    }
    const name = /query (\w+)/.exec(query)?.[1] ?? "";
    calls.push({ name, variables });
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
                  product.variants.map((id) => ({ id })),
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
