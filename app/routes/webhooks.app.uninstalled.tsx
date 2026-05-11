import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  const deletedSessions = await db.session.deleteMany({ where: { shop } });

  console.info("Processed app/uninstalled webhook", {
    shop,
    topic,
    deletedSessions: deletedSessions.count,
  });

  return new Response(null, { status: 200 });
};
