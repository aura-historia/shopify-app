import type { ActionFunctionArgs } from "react-router";
import shopify, { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  const sessions = await shopify.sessionStorage.findSessionsByShop(shop);
  await shopify.sessionStorage.deleteSessions(
    sessions.map((session) => session.id),
  );

  console.info("Processed app/uninstalled webhook", {
    shop,
    topic,
    deletedSessions: sessions.length,
  });

  return new Response(null, { status: 200 });
};
