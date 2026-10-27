import type { AppLoadContext } from "react-router";
import {
  configureShopifyListingSource,
  triggerBackfill,
} from "./backfill.server";
import {
  getAuraHistoriaApiBaseUrl,
  getAuraHistoriaOAuthConfig,
  summarizeOAuthError,
} from "./oauth.server";
import { offlineGraphql } from "./shipping/runtime.server";
import { loadShopCredentials } from "./shop-credentials.server";

// Starts a channel-filtered catalog import for the shop's current Aura
// connection. Shared by the manual re-import and scope-grant recovery.
export async function queueCatalogImport(
  context: AppLoadContext,
  shop: string,
): Promise<boolean> {
  const credentials = await loadShopCredentials(
    context.cloudflare.env.KV,
    shop,
  );
  if (!credentials) return false;
  try {
    const config = getAuraHistoriaOAuthConfig(context.cloudflare.env);
    const apiBaseUrl =
      getAuraHistoriaApiBaseUrl(context.cloudflare.env) ??
      new URL(config.tokenUrl).origin;
    const graphqlRequest = offlineGraphql(context, shop);
    const metadata = await configureShopifyListingSource(
      graphqlRequest,
      apiBaseUrl,
      credentials.listingSourceId,
      credentials.accessToken,
      shop,
    );
    return await triggerBackfill(
      graphqlRequest,
      context.cloudflare.env.KV,
      shop,
      credentials.listingSourceId,
      credentials.accessToken,
      apiBaseUrl,
      metadata,
    );
  } catch (error) {
    console.error(
      "Failed to queue catalog import:",
      summarizeOAuthError(error, [credentials.accessToken]),
    );
    return false;
  }
}
