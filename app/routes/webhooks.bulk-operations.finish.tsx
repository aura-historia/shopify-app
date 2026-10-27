import type { ActionFunctionArgs } from "react-router";
import {
  clearBackfillContext,
  fetchBulkOperationResult,
  loadBackfillContext,
  processBackfillResults,
} from "../backfill.server";
import {
  CHANNEL_PUBLICATION_ERRORS,
  resolveChannelPublication,
  saveCatalogImportStatus,
} from "../catalog.server";
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
      error: "SHOPIFY_READ_FAILED",
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
        const exportResult = await fetchBulkOperationResult(
          graphqlRequest,
          bulkOpId,
        );
        // Writes use the current installation's access and publication. A
        // revoked scope or replaced channel invalidates the whole snapshot.
        const publication = await resolveChannelPublication(graphqlRequest);
        if (
          publication.state !== "ready" ||
          publication.publicationId !== backfillCtx.publicationId
        ) {
          await saveCatalogImportStatus(context.cloudflare.env.KV, shop, {
            phase: "failed",
            total: 0,
            failed: 0,
            error:
              publication.state === "ready"
                ? "PUBLICATION_CHANGED"
                : CHANNEL_PUBLICATION_ERRORS[publication.state],
          });
          return;
        }

        const result = await processBackfillResults(exportResult, backfillCtx);
        const error = !result.complete
          ? "INCOMPLETE_EXPORT"
          : !result.reconciled
            ? "RECONCILIATION_FAILED"
            : undefined;
        await saveCatalogImportStatus(context.cloudflare.env.KV, shop, {
          phase: result.failures.length || error ? "failed" : "submitted",
          total: result.total,
          failed: result.failures.length,
          eligible: result.eligible,
          withdrawn: result.withdrawn,
          reconciled: result.reconciled,
          ...(error && { error }),
        });

        console.log(
          `Backfill complete for ${shop}: ${result.total} products, ${result.eligible} published to Aura, ${result.withdrawn} withdrawn, ${result.failures.length} failures, reconciled=${result.reconciled}`,
        );

        if (result.failures.length > 0) {
          console.warn("Failed product IDs:", result.failures.join(", "));
        }
      } catch (error) {
        await saveCatalogImportStatus(context.cloudflare.env.KV, shop, {
          phase: "failed",
          total: 0,
          failed: 0,
          error: "SHOPIFY_READ_FAILED",
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
