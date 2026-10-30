import type { ActionFunctionArgs } from "react-router";
import { catalogImporter } from "../shipping/runtime.server";
import { getShopifyWebhook } from "../shopify.server";

interface BulkOperationPayload {
  admin_graphql_api_id?: string;
  status?: string;
  type?: string;
}

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const shopify = getShopifyWebhook(context);
  const { shop, topic, payload } = await shopify.authenticate.webhook(request);
  if (topic !== "BULK_OPERATIONS_FINISH")
    return new Response(null, { status: 400 });
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return new Response(null, { status: 400 });
  const body = payload as BulkOperationPayload;

  if (body.type !== "query") {
    return new Response(null, { status: 200 });
  }

  const bulkOpId = body.admin_graphql_api_id;
  if (!bulkOpId) {
    return new Response(null, { status: 200 });
  }

  // Processing runs in bounded, resumable Durable Object alarms rather than
  // this request's short waitUntil window. The importer admits only the
  // export of its current import generation, once; deliveries for retired or
  // finished imports change nothing. Shopify retries the delivery if it could
  // not be committed.
  const importer = catalogImporter(context, shop);
  try {
    if (body.status === "completed") await importer.start(bulkOpId);
    else await importer.exportFailed(bulkOpId);
  } catch {
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 200 });
};
