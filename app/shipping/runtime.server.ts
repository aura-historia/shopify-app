import type { AppLoadContext } from "react-router";
import type { GraphqlRequestFn } from "../backfill.server";

// Internal Workers RPC only. No HTTP bridge, provider token, or backend caller.
export function shopCoordinator(context: AppLoadContext, shop: string) {
  return context.cloudflare.env.SHOP_COORDINATOR.getByName(shop.toLowerCase());
}

export function catalogImporter(context: AppLoadContext, shop: string) {
  return context.cloudflare.env.CATALOG_IMPORTER.getByName(shop.toLowerCase());
}

export function offlineGraphql(
  context: AppLoadContext,
  shop: string,
): GraphqlRequestFn {
  return (query, variables) =>
    shopCoordinator(context, shop).graphql(shop, query, variables);
}

export async function queueShipping(context: AppLoadContext, shop: string) {
  try {
    return await shopCoordinator(context, shop).requestShipping(shop);
  } catch {
    // Shipping admission must not roll back a successful catalog connection.
    return false;
  }
}
