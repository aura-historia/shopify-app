import { DurableObject } from "cloudflare:workers";
import {
  type CatalogImportJob,
  type CatalogImportStore,
  clearBackfillContext,
  type GraphqlRequestFn,
  loadBackfillContext,
  runCatalogImportStep,
} from "../app/backfill.server";
import { saveCatalogImportStatus } from "../app/catalog.server";
import type { CloudflareShopifyEnv } from "../app/shopify.server";

// Wall-clock budget of one alarm. Remaining batches continue in the next one,
// well within the five-minute window that reports a stalled import as failed.
export const CATALOG_STEP_BUDGET_MS = 20_000;
export const CATALOG_MAX_ATTEMPTS = 6;

// Per-shop catalog import driven by alarms instead of a request's waitUntil,
// so large catalogs are bounded per step and resume after interruptions.
export class CatalogImporter extends DurableObject<CloudflareShopifyEnv> {
  // Duplicate completion webhooks never restart or fork an admitted import.
  // A new import discards the retained data of a superseded one.
  async start(shop: string, bulkOperationId: string) {
    const job = await this.ctx.storage.get<CatalogImportJob>("job");
    if (job?.bulkOperationId !== bulkOperationId) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put<CatalogImportJob>("job", {
        shop,
        bulkOperationId,
        listingPages: 0,
        cursor: 0,
        failed: 0,
        withdrawn: 0,
        attempts: 0,
      });
    }
    await this.ctx.storage.setAlarm(Date.now());
  }

  private store(): CatalogImportStore {
    return {
      saveJob: (job) => this.ctx.storage.put("job", job),
      putIds: (key, ids) => this.ctx.storage.put(key, ids),
      getIds: async (key) => {
        const ids = await this.ctx.storage.get<string[]>(key);
        if (!ids) throw new Error(`Missing retained catalog data ${key}`);
        return ids;
      },
    };
  }

  async alarm() {
    const job = await this.ctx.storage.get<CatalogImportJob>("job");
    if (!job) return;
    // The KV context carries the Aura credentials. Disconnect, uninstall or a
    // newer import replaces or clears it and thereby stops this job.
    const context = await loadBackfillContext(this.env.KV, job.shop);
    if (context?.bulkOperationId !== job.bulkOperationId) {
      await this.ctx.storage.deleteAll();
      return;
    }
    // Shopify reads share the coordinator's serialized offline token refresh.
    const graphql: GraphqlRequestFn = (query, variables) =>
      this.env.SHOP_COORDINATOR.getByName(job.shop.toLowerCase()).graphql(
        job.shop,
        query,
        variables,
      );
    let step: Awaited<ReturnType<typeof runCatalogImportStep>>;
    try {
      step = await runCatalogImportStep(
        job,
        context,
        graphql,
        Date.now() + CATALOG_STEP_BUDGET_MS,
        this.store(),
      );
      job.attempts = 0;
    } catch (error) {
      job.attempts++;
      console.error(
        `Catalog import step ${job.attempts} failed for ${job.shop}:`,
        (error instanceof Error ? error.message : String(error))
          .replaceAll(context.accessToken, "[redacted]")
          .slice(0, 180),
      );
      if (job.attempts < CATALOG_MAX_ATTEMPTS) {
        await this.ctx.storage.put("job", job);
        await this.ctx.storage.setAlarm(Date.now() + 1000 * 2 ** job.attempts);
        return;
      }
      step = {
        done: true,
        status: {
          phase: "failed",
          total: 0,
          failed: 0,
          error: "SHOPIFY_READ_FAILED",
        },
      };
    }
    await saveCatalogImportStatus(this.env.KV, job.shop, step.status);
    if (!step.done) {
      await this.ctx.storage.put("job", job);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return;
    }
    await this.ctx.storage.deleteAll();
    if (
      (await loadBackfillContext(this.env.KV, job.shop))?.bulkOperationId ===
      job.bulkOperationId
    )
      await clearBackfillContext(this.env.KV, job.shop);
    console.log(
      `Catalog import ${step.status.phase} for ${job.shop}: ${step.status.total} products, ${step.status.eligible ?? 0} published to Aura, ${step.status.withdrawn ?? 0} withdrawn, ${step.status.failed} failures${step.status.error ? ` (${step.status.error})` : ""}`,
    );
  }
}
