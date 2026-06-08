import type { ActionFunctionArgs } from "react-router";
import {
  clearBackfillContext,
  createAdminGraphqlRequest,
  fetchBulkOperationResultUrl,
  loadBackfillContext,
  processBackfillResults,
} from "../backfill.server";
import { getShopify } from "../shopify.server";

interface BulkOperationPayload {
  admin_graphql_api_id?: string;
  status?: string;
  type?: string;
}

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const shopify = getShopify(context);
  const { shop, payload } = await shopify.authenticate.webhook(request);
  const body = payload as BulkOperationPayload;

  if (body.status !== "completed" || body.type !== "query") {
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

  context.cloudflare.ctx.waitUntil(
    (async () => {
      try {
        const { admin } = await shopify.unauthenticated.admin(shop);
        const graphqlRequest = createAdminGraphqlRequest(admin);
        const jsonlUrl = await fetchBulkOperationResultUrl(
          graphqlRequest,
          bulkOpId,
        );

        if (!jsonlUrl) {
          console.warn(
            `Bulk operation ${bulkOpId} has no download URL for ${shop}`,
          );
          return;
        }

        const result = await processBackfillResults(jsonlUrl, backfillCtx);

        console.log(
          `Backfill complete for ${shop}: ${result.total} products, ${result.failures.length} failures`,
        );

        if (result.failures.length > 0) {
          console.warn("Failed product IDs:", result.failures.join(", "));
        }
      } catch (error) {
        console.error(`Backfill processing failed for ${shop}:`, error);
      } finally {
        await clearBackfillContext(context.cloudflare.env.KV, shop);
      }
    })(),
  );

  return new Response(null, { status: 200 });
};
