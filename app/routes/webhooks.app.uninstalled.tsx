import type { ActionFunctionArgs } from "react-router";
import { clearBackfillContext } from "../backfill.server";
import { clearCatalogImportStatus } from "../catalog.server";
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
  if (topic !== "APP_UNINSTALLED") return new Response(null, { status: 400 });
  const credentials = await loadShopCredentials(
    context.cloudflare.env.KV,
    shop,
  );

  // Fence first and durably admit owned withdrawals. The worker resolves Aura
  // credentials from protected cleanup storage after Shopify sessions are gone.
  await shopCoordinator(context, shop).disconnectShipping(shop, true);
  await clearShopCredentials(context.cloudflare.env.KV, shop);
  await clearShopCredentialsDisconnected(context.cloudflare.env.KV, shop);
  await clearBackfillContext(context.cloudflare.env.KV, shop);
  await clearCatalogImportStatus(context.cloudflare.env.KV, shop);

  const sessions = await shopify.sessionStorage.findSessionsByShop(shop);
  // KV's shop index can contain duplicates and entries whose session was
  // already deleted by an earlier, interrupted delivery.
  const sessionIds = [
    ...new Set(sessions.filter(Boolean).map((session) => session.id)),
  ];
  if (!(await shopify.sessionStorage.deleteSessions(sessionIds)))
    return new Response(null, { status: 503 });

  console.info("Processed app/uninstalled webhook", {
    shop,
    topic,
    deletedSessions: sessionIds.length,
    clearedAuraHistoriaCredentials: Boolean(credentials),
  });

  return new Response(null, { status: 200 });
};
