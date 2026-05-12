import type { ActionFunctionArgs } from "react-router";
import { getShopify } from "../shopify.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const shopify = getShopify(context);
  const { shop, topic } = await shopify.authenticate.webhook(request);
  const sessions = await shopify.sessionStorage.findSessionsByShop(shop);
  await shopify.sessionStorage.deleteSessions(
    sessions.map((session: { id: string }) => session.id),
  );

  console.info("Processed app/uninstalled webhook", {
    shop,
    topic,
    deletedSessions: sessions.length,
  });

  return new Response(null, { status: 200 });
};
