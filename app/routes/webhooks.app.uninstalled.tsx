import type { ActionFunctionArgs } from "react-router";
import { clearBackfillContext } from "../backfill.server";
import { shopCoordinator } from "../shipping/runtime.server";
import {
  clearShopCredentials,
  clearShopCredentialsDisconnected,
  loadShopCredentials,
} from "../shop-credentials.server";
import { getShopifyWebhook } from "../shopify.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const shopify = getShopifyWebhook(context);
  const { shop, topic } = await shopify.authenticate.webhook(request);
  const credentials = await loadShopCredentials(
    context.cloudflare.env.KV,
    shop,
  );

  if (topic !== "APP_UNINSTALLED") return new Response(null, { status: 400 });
  // Fence first and durably admit owned withdrawals. The worker resolves Aura
  // credentials from protected cleanup storage after Shopify sessions are gone.
  await shopCoordinator(context, shop).disconnectShipping(shop, true);
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
