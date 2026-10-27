import type { ActionFunctionArgs } from "react-router";
import { clearBackfillContext, loadBackfillContext } from "../backfill.server";
import { saveCatalogImportStatus } from "../catalog.server";
import { catalogImporter } from "../shipping/runtime.server";
import { getShopifyWebhook } from "../shopify.server";

interface BulkOperationPayload {
  admin_graphql_api_id?: string;
  status?: string;
  type?: string;
}

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const shopify = getShopifyWebhook(context);
  const { shop, payload } = await shopify.authenticate.webhook(request);
  const body = payload as BulkOperationPayload;

  if (body.type !== "query") {
    return new Response(null, { status: 200 });
  }

  const bulkOpId = body.admin_graphql_api_id;
  if (!bulkOpId) {
    return new Response(null, { status: 200 });
  }

  const backfillCtx = await loadBackfillContext(
    context.cloudflare.env.KV,
    shop,
  );

  if (!backfillCtx || backfillCtx.bulkOperationId !== bulkOpId) {
    return new Response(null, { status: 200 });
  }

  if (body.status !== "completed") {
    await saveCatalogImportStatus(context.cloudflare.env.KV, shop, {
      phase: "failed",
      total: 0,
      failed: 0,
      error: "SHOPIFY_READ_FAILED",
    });
    await clearBackfillContext(context.cloudflare.env.KV, shop);
    return new Response(null, { status: 200 });
  }

  // Processing runs in bounded, resumable Durable Object alarms rather than
  // this request's short waitUntil window. Admission is idempotent per bulk
  // operation; Shopify retries the delivery if it could not be committed.
  try {
    await catalogImporter(context, shop).start(shop, bulkOpId);
  } catch {
    return new Response(null, { status: 503 });
  }
  return new Response(null, { status: 200 });
};
