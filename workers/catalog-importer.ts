import { DurableObject } from "cloudflare:workers";
import {
  type BackfillContext,
  type CatalogImportJob,
  clearBackfillContext,
  type GraphqlRequestFn,
  loadBackfillContext,
  runCatalogImportStep,
  SupersededImportError,
  storeBackfillContext,
} from "../app/backfill.server";
import {
  type CatalogImportError,
  type CatalogImportStatus,
  readCatalogImportStatus,
} from "../app/catalog.server";
import type { CloudflareShopifyEnv } from "../app/shopify.server";

// Wall-clock budget of one alarm. Remaining batches continue in the next one,
// well within the five-minute window that reports a stalled import as failed.
export const CATALOG_STEP_BUDGET_MS = 20_000;
export const CATALOG_MAX_ATTEMPTS = 6;

type Progress = Omit<CatalogImportStatus, "updatedAt">;
const stamp = (status: Progress): CatalogImportStatus => ({
  ...status,
  updatedAt: new Date().toISOString(),
});

// Per-shop catalog import driven by alarms instead of a request's waitUntil,
// so large catalogs are bounded per step and resume after interruptions.
//
// The importer is the authority over the shop's import generations. Starting
// an import, disconnect, uninstall and connection replacement each retire the
// current generation in one storage transaction before they are acknowledged.
// Only the current generation can queue or admit its export, schedule the
// alarm, submit batches or record progress, and each of those writes checks
// the generation in the same transaction. A request already in flight when
// its generation is retired completes or times out and is discarded; nothing
// is resent for it. A batch Aura already admitted stays admitted.
export class CatalogImporter extends DurableObject<CloudflareShopifyEnv> {
  // Retires the current generation with its job and alarm.
  private async advance(transaction: DurableObjectTransaction) {
    const retired = (await transaction.get<number>("generation")) ?? 0;
    // Generations stay unique even if storage were erased under an old alarm.
    const generation = Math.max(retired + 1, Date.now());
    await transaction.put("generation", generation);
    await transaction.delete("job");
    await transaction.deleteAlarm();
    return { retired, generation };
  }

  // Ends the current generation's job with a failure the merchant retries.
  private async end(
    transaction: DurableObjectTransaction,
    error: CatalogImportError,
  ) {
    await transaction.delete("job");
    await transaction.deleteAlarm();
    await transaction.put(
      "status",
      stamp({ phase: "failed", total: 0, failed: 0, error }),
    );
  }

  // A context key belongs to one generation, so releasing it never touches a
  // newer import's credentials. KV permits one write per key per second, and
  // a context can be released right after it was stored.
  private async release(shop: string | undefined, generation: number) {
    if (!shop || !generation) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await clearBackfillContext(this.env.KV, shop, generation);
        return;
      } catch {
        if (attempt < 2)
          await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    // The retired generation can no longer use it, and it expires.
    console.warn(`Catalog import context of ${shop} could not be released`);
  }

  // Called by the shop coordinator once it verified the connection, in the
  // same serialized order as disconnect and replacement.
  async begin(shop: string) {
    const { retired, generation } = await this.ctx.storage.transaction(
      async (transaction) => {
        const generations = await this.advance(transaction);
        await transaction.put("shop", shop);
        await transaction.put(
          "status",
          stamp({ phase: "queued", total: 0, failed: 0 }),
        );
        return generations;
      },
    );
    await this.release(shop, retired);
    return generation;
  }

  // Disconnect, uninstall and connection replacement. Only the generation
  // counter remains.
  async stop() {
    const { shop, retired } = await this.ctx.storage.transaction(
      async (transaction) => {
        const shop = await transaction.get<string>("shop");
        await transaction.delete("shop");
        await transaction.delete("status");
        return { ...(await this.advance(transaction)), shop };
      },
    );
    await this.release(shop, retired);
  }

  // Records the export a generation started. Its credentials are stored
  // first, so an admitted job always finds them.
  async queue(generation: number, context: BackfillContext) {
    const shop = context.shopDomain;
    await storeBackfillContext(this.env.KV, shop, generation, context);
    const queued = await this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<number>("generation")) !== generation)
        return false;
      await transaction.put<CatalogImportJob>("job", {
        shop,
        generation,
        bulkOperationId: context.bulkOperationId,
        admitted: false,
        cursor: 0,
        failed: 0,
        withdrawn: 0,
        attempts: 0,
      });
      await transaction.put(
        "status",
        stamp({ phase: "queued", total: 0, failed: 0 }),
      );
      return true;
    });
    if (!queued) await this.release(shop, generation);
    return queued;
  }

  // A current generation that could not start its export.
  async fail(generation: number, error: CatalogImportError) {
    const failed = await this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<number>("generation")) !== generation)
        return null;
      await this.end(transaction, error);
      return { shop: await transaction.get<string>("shop") };
    });
    if (failed) await this.release(failed.shop, generation);
    return failed !== null;
  }

  // Shopify finished the current generation's export. A delayed or duplicate
  // delivery for a retired, failed or finished import matches no job and
  // changes nothing; a duplicate never restarts an admitted one.
  async start(bulkOperationId: string) {
    await this.ctx.storage.transaction(async (transaction) => {
      const job = await transaction.get<CatalogImportJob>("job");
      // Jobs from before import generations are never admitted.
      if (
        job?.bulkOperationId !== bulkOperationId ||
        typeof job.generation !== "number"
      )
        return;
      // A lost alarm is rearmed, a pending backoff is kept.
      if (job.admitted && (await transaction.getAlarm()) !== null) return;
      await transaction.put<CatalogImportJob>("job", {
        ...job,
        admitted: true,
      });
      await transaction.setAlarm(Date.now());
    });
  }

  async exportFailed(bulkOperationId: string) {
    const job = await this.ctx.storage.transaction(async (transaction) => {
      const job = await transaction.get<CatalogImportJob>("job");
      if (job?.bulkOperationId !== bulkOperationId || job.admitted) return null;
      await this.end(transaction, "SHOPIFY_READ_FAILED");
      return job;
    });
    if (job) await this.release(job.shop, job.generation);
  }

  async status() {
    return readCatalogImportStatus(await this.ctx.storage.get("status"));
  }

  // begin(), stop(), fail() and exportFailed() replace or delete the stored
  // job in the same storage, so an alarm's writes apply only while its job is
  // current.
  private whileCurrent(
    job: CatalogImportJob,
    write: (transaction: DurableObjectTransaction) => Promise<unknown>,
  ): Promise<boolean> {
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<CatalogImportJob>("job");
      if (current?.generation !== job.generation) return false;
      await write(transaction);
      return true;
    });
  }

  async alarm() {
    const job = await this.ctx.storage.get<CatalogImportJob>("job");
    if (!job?.admitted) return;
    // Shopify reads share the coordinator's serialized offline token refresh.
    const graphql: GraphqlRequestFn = (query, variables) =>
      this.env.SHOP_COORDINATOR.getByName(job.shop.toLowerCase()).graphql(
        job.shop,
        query,
        variables,
      );
    let context: BackfillContext | null = null;
    let step: Awaited<ReturnType<typeof runCatalogImportStep>>;
    try {
      // The generation's own context carries the Aura credentials. A retired
      // generation's context is released, so its alarm cannot read it again.
      context = await loadBackfillContext(
        this.env.KV,
        job.shop,
        job.generation,
      );
      if (context?.bulkOperationId !== job.bulkOperationId)
        throw new Error("Catalog import context is unavailable");
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
            throw new SupersededImportError();
        },
      );
      job.attempts = 0;
    } catch (error) {
      // The newer import or the stop owns the job, alarm, status and context.
      if (error instanceof SupersededImportError) return;
      job.attempts++;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `Catalog import step ${job.attempts} failed for ${job.shop}:`,
        (context
          ? message.replaceAll(context.accessToken, "[redacted]")
          : message
        ).slice(0, 180),
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
    const status = stamp(step.status);
    if (!step.done) {
      await this.whileCurrent(job, async (transaction) => {
        await transaction.put("job", job);
        await transaction.put("status", status);
        await transaction.setAlarm(Date.now() + 1000);
      });
      return;
    }
    // The outcome and the end of the job commit together, and only while this
    // generation is current.
    if (
      !(await this.whileCurrent(job, async (transaction) => {
        await transaction.delete("job");
        await transaction.put("status", status);
      }))
    )
      return;
    await this.release(job.shop, job.generation);
    console.log(
      `Catalog import ${status.phase} for ${job.shop}: ${status.total} products, ${status.eligible ?? 0} published to Aura, ${status.withdrawn ?? 0} withdrawn, ${status.failed} failures${status.error ? ` (${status.error})` : ""}`,
    );
  }
}
