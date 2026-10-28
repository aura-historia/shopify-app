import { DurableObject } from "cloudflare:workers";
import {
  type CatalogImportJob,
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

class SupersededImport extends Error {}

// Per-shop catalog import driven by alarms instead of a request's waitUntil,
// so large catalogs are bounded per step and resume after interruptions.
export class CatalogImporter extends DurableObject<CloudflareShopifyEnv> {
  // Duplicate completion webhooks never restart or fork an admitted import.
  async start(shop: string, bulkOperationId: string) {
    const job = await this.ctx.storage.get<CatalogImportJob>("job");
    if (job?.bulkOperationId !== bulkOperationId) {
      await this.ctx.storage.put<CatalogImportJob>("job", {
        shop,
        bulkOperationId,
        cursor: 0,
        failed: 0,
        withdrawn: 0,
        attempts: 0,
      });
    }
    await this.ctx.storage.setAlarm(Date.now());
  }

  // start() can admit a newer import while an alarm awaits network I/O. Job,
  // alarm and cleanup writes therefore apply only while the stored job still
  // belongs to the alarm's own bulk operation.
  private whileCurrent(
    job: CatalogImportJob,
    write: (transaction: DurableObjectTransaction) => Promise<unknown>,
  ): Promise<boolean> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<CatalogImportJob>("job");
      if (current?.bulkOperationId !== job.bulkOperationId) return false;
      await write(transaction);
      return true;
    });
  }

  async alarm() {
    const job = await this.ctx.storage.get<CatalogImportJob>("job");
    if (!job) return;
    // The KV context carries the Aura credentials. Disconnect, uninstall or a
    // newer import replaces or clears it and thereby stops this job.
    const context = await loadBackfillContext(this.env.KV, job.shop);
    if (context?.bulkOperationId !== job.bulkOperationId) {
      await this.whileCurrent(job, (transaction) => transaction.delete("job"));
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
        CATALOG_STEP_BUDGET_MS,
        async (next) => {
          if (
            !(await this.whileCurrent(next, (transaction) =>
              transaction.put("job", next),
            ))
          )
            throw new SupersededImport();
        },
      );
      job.attempts = 0;
    } catch (error) {
      // The newer import owns the job, alarm, status and context.
      if (error instanceof SupersededImport) return;
      job.attempts++;
      console.error(
        `Catalog import step ${job.attempts} failed for ${job.shop}:`,
        (error instanceof Error ? error.message : String(error))
          .replaceAll(context.accessToken, "[redacted]")
          .slice(0, 180),
      );
      if (job.attempts < CATALOG_MAX_ATTEMPTS) {
        await this.whileCurrent(job, async (transaction) => {
          await transaction.put("job", job);
          await transaction.setAlarm(Date.now() + 1000 * 2 ** job.attempts);
        });
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
    if (
      (await this.ctx.storage.get<CatalogImportJob>("job"))?.bulkOperationId !==
      job.bulkOperationId
    )
      return;
    await saveCatalogImportStatus(this.env.KV, job.shop, step.status);
    if (!step.done) {
      await this.whileCurrent(job, async (transaction) => {
        await transaction.put("job", job);
        await transaction.setAlarm(Date.now() + 1000);
      });
      return;
    }
    if (
      !(await this.whileCurrent(job, (transaction) =>
        transaction.delete("job"),
      ))
    )
      return;
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
