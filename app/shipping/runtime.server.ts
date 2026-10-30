import type { AppLoadContext } from "react-router";
import type { CatalogImports, GraphqlRequestFn } from "../backfill.server";

// Internal Workers RPC only. No HTTP bridge, provider token, or backend caller.
export function shopCoordinator(context: AppLoadContext, shop: string) {
  return context.cloudflare.env.SHOP_COORDINATOR.getByName(shop.toLowerCase());
}

export function catalogImporter(context: AppLoadContext, shop: string) {
  return context.cloudflare.env.CATALOG_IMPORTER.getByName(shop.toLowerCase());
}

// Imports for a stored connection. The coordinator begins one only while that
// connection is bound and running, in order with disconnect and replacement.
export function catalogImports(
  context: AppLoadContext,
  shop: string,
  connectionId: string,
): CatalogImports {
  const importer = catalogImporter(context, shop);
  return {
    begin: () =>
      shopCoordinator(context, shop).beginCatalogImport(shop, connectionId),
    queue: (generation, backfill) => importer.queue(generation, backfill),
    fail: (generation, error) => importer.fail(generation, error),
    status: () => importer.status(),
  };
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
