import type { ActionFunctionArgs } from "react-router";
import { clearBackfillContext } from "../backfill.server";
import {
  getAuraHistoriaOAuthConfig,
  getMissingAuraHistoriaOAuthConfig,
  revokeAuraHistoriaAccessToken,
  summarizeOAuthError,
} from "../oauth.server";
import {
  clearShopCredentials,
  clearShopCredentialsDisconnected,
  loadShopCredentials,
} from "../shop-credentials.server";
import { getShopify } from "../shopify.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const shopify = getShopify(context);
  const { shop, topic } = await shopify.authenticate.webhook(request);
  const credentials = await loadShopCredentials(
    context.cloudflare.env.KV,
    shop,
  );

  if (credentials) {
    const config = getAuraHistoriaOAuthConfig(context.cloudflare.env);
    const missingConfig = getMissingAuraHistoriaOAuthConfig(config);

    if (missingConfig.length === 0) {
      try {
        await revokeAuraHistoriaAccessToken(config, credentials.accessToken);
      } catch (error) {
        console.warn("Failed to revoke Aura Historia access on uninstall", {
          shop,
          error: summarizeOAuthError(error),
        });
      }
    } else {
      console.warn("Skipped Aura Historia token revocation on uninstall", {
        shop,
        missingConfig,
      });
    }
  }

  await clearShopCredentials(context.cloudflare.env.KV, shop);
  await clearShopCredentialsDisconnected(context.cloudflare.env.KV, shop);
  await clearBackfillContext(context.cloudflare.env.KV, shop);

  const sessions = await shopify.sessionStorage.findSessionsByShop(shop);
  await shopify.sessionStorage.deleteSessions(
    sessions.map((session: { id: string }) => session.id),
  );

  console.info("Processed app/uninstalled webhook", {
    shop,
    topic,
    deletedSessions: sessions.length,
    clearedAuraHistoriaCredentials: Boolean(credentials),
  });

  return new Response(null, { status: 200 });
};
