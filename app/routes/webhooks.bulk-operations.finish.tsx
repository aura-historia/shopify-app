import type { ActionFunctionArgs } from "react-router";
import {
  clearBackfillContext,
  fetchBulkOperationResultUrl,
  loadBackfillContext,
  processBackfillResults,
} from "../backfill.server";
import { saveCatalogImportStatus } from "../catalog.server";
import { summarizeOAuthError } from "../oauth.server";
import { offlineGraphql } from "../shipping/runtime.server";
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
    });
    await clearBackfillContext(context.cloudflare.env.KV, shop);
    return new Response(null, { status: 200 });
  }

  context.cloudflare.ctx.waitUntil(
    (async () => {
      try {
        await saveCatalogImportStatus(context.cloudflare.env.KV, shop, {
          phase: "processing",
          total: 0,
          failed: 0,
        });
        const graphqlRequest = offlineGraphql(context, shop);
        const jsonlUrl = await fetchBulkOperationResultUrl(
          graphqlRequest,
          bulkOpId,
        );

        if (!jsonlUrl) {
          await saveCatalogImportStatus(context.cloudflare.env.KV, shop, {
            phase: "submitted",
            total: 0,
            failed: 0,
          });
          return;
        }

        const result = await processBackfillResults(jsonlUrl, backfillCtx);
        await saveCatalogImportStatus(context.cloudflare.env.KV, shop, {
          phase: result.failures.length ? "failed" : "submitted",
          total: result.total,
          failed: result.failures.length,
        });

        console.log(
          `Backfill complete for ${shop}: ${result.total} products, ${result.failures.length} failures`,
        );

        if (result.failures.length > 0) {
          console.warn("Failed product IDs:", result.failures.join(", "));
        }
      } catch (error) {
        await saveCatalogImportStatus(context.cloudflare.env.KV, shop, {
          phase: "failed",
          total: 0,
          failed: 0,
        });
        console.error(
          `Backfill processing failed for ${shop}:`,
          summarizeOAuthError(error, [backfillCtx.accessToken]),
        );
      } finally {
        await clearBackfillContext(context.cloudflare.env.KV, shop);
      }
    })(),
  );

  return new Response(null, { status: 200 });
};
