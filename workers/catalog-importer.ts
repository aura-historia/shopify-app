import { DurableObject } from "cloudflare:workers";
import {
  type BackfillContext,
  type BulkOperationState,
  CATALOG_EXPORT_WINDOW_MS,
  CATALOG_IMPORT_WINDOW_MS,
  CATALOG_SETUP_WINDOW_MS,
  type CatalogImportJob,
  type CatalogSetupContext,
  type CatalogSetupJob,
  cancelBulkOperation,
  catalogProgress,
  catalogSetupDelay,
  clearBackfillContext,
  EXPORT_PLAN_VERSION,
  type GraphqlRequestFn,
  loadBackfillContext,
  loadCatalogSetupContext,
  readBulkOperationState,
  runCatalogImportStep,
  SupersededImportError,
  storeBackfillContext,
  submitBulkOperation,
} from "../app/backfill.server";
import {
  awaitsChannelPublication,
  type CatalogImportError,
  type CatalogImportStatus,
  CHANNEL_PUBLICATION_ERRORS,
  type ChannelPublicationState,
  readCatalogImportStatus,
  resolveChannelPublication,
} from "../app/catalog.server";
import type { CloudflareShopifyEnv } from "../app/shopify.server";

// Wall-clock budget of one alarm. Remaining batches continue in the next one,
// well within the five-minute window that reports a stalled import as failed.
export const CATALOG_STEP_BUDGET_MS = 20_000;
export const CATALOG_MAX_ATTEMPTS = 6;
// While Shopify exports, the importer checks the export this often. It admits
// an export whose completion webhook was lost and keeps the queued status
// current, well within the hour after which a silent status reads as failed.
// A completion is admitted until one check after the export window, so a
// webhook delayed past the last check is not lost; the context's TTL leaves
// an hour for this.
export const CATALOG_EXPORT_POLL_MS = 5 * 60_000;

type Progress = Omit<CatalogImportStatus, "updatedAt">;
const stamp = (status: Progress): CatalogImportStatus => ({
  ...status,
  updatedAt: new Date().toISOString(),
});
// Jobs from before import generations, or planned under other segment rules,
// are never resumed: a batch could be resent with other content under the
// same idempotency key.
const resumable = (job: CatalogImportJob) =>
  typeof job.generation === "number" && job.plan === EXPORT_PLAN_VERSION;

// Per-shop catalog import driven by alarms instead of a request's waitUntil,
// so large catalogs are bounded per step and resume after interruptions.
//
// The importer is the authority over the shop's import generations. Starting
// an import, disconnect, uninstall and connection replacement each retire the
// current generation in one storage transaction before they are acknowledged.
// Only the current generation can await its channel publication, queue or
// admit its export, schedule the alarm, submit batches or record progress,
// and each of those writes checks the generation in the same transaction. A
// request already in flight when its generation is retired completes or
// times out and is discarded; nothing is resent for it. A batch Aura already
// admitted stays admitted.
export class CatalogImporter extends DurableObject<CloudflareShopifyEnv> {
  // Retires the current generation with its setup, job and alarm.
  private async advance(transaction: DurableObjectTransaction) {
    const retired = (await transaction.get<number>("generation")) ?? 0;
    // Generations stay unique even if storage were erased under an old alarm.
    const generation = Math.max(retired + 1, Date.now());
    await transaction.put("generation", generation);
    await transaction.delete("setup");
    await transaction.delete("job");
    await transaction.deleteAlarm();
    return { retired, generation };
  }

  // Ends the current generation's setup or job with a failure the merchant
  // retries.
  private async end(
    transaction: DurableObjectTransaction,
    error: CatalogImportError,
  ) {
    await transaction.delete("setup");
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
  // first, so an admitted job always finds them, and they expire only after
  // both the export and the import window closed.
  async queue(generation: number, context: BackfillContext) {
    const shop = context.shopDomain;
    await storeBackfillContext(this.env.KV, shop, generation, context);
    const queued = await this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<number>("generation")) !== generation)
        return false;
      // The generation's publication wait, if any, ends with its export.
      await transaction.delete("setup");
      await transaction.put<CatalogImportJob>("job", {
        shop,
        generation,
        bulkOperationId: context.bulkOperationId,
        plan: EXPORT_PLAN_VERSION,
        queuedAt: Date.now(),
        admitted: false,
        offset: 0,
        cursor: 0,
        part: 0,
        total: 0,
        eligible: 0,
        rejected: 0,
        unknown: 0,
        failed: 0,
        withdrawn: 0,
        attempts: 0,
      });
      await transaction.put(
        "status",
        stamp({ phase: "queued", total: 0, failed: 0 }),
      );
      await transaction.setAlarm(Date.now() + CATALOG_EXPORT_POLL_MS);
      return true;
    });
    if (!queued) await this.release(shop, generation);
    return queued;
  }

  // A current generation whose channel connection is set up, but whose
  // publication Shopify did not return yet. Its credentials are stored first,
  // as for an export, and the alarm checks the publication again within the
  // setup window. `error` is what Shopify returned.
  async awaitPublication(
    generation: number,
    context: CatalogSetupContext,
    error: CatalogImportError,
  ) {
    const shop = context.shopDomain;
    await storeBackfillContext(this.env.KV, shop, generation, context);
    const waiting = await this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<number>("generation")) !== generation)
        return false;
      await transaction.put<CatalogSetupJob>("setup", {
        shop,
        generation,
        listingSourceId: context.listingSourceId,
        since: Date.now(),
        checks: 0,
        error,
      });
      await transaction.put(
        "status",
        stamp({
          phase: "queued",
          total: 0,
          failed: 0,
          awaiting: "CHANNEL_PUBLICATION",
        }),
      );
      await transaction.setAlarm(Date.now() + catalogSetupDelay(0));
      return true;
    });
    if (!waiting) await this.release(shop, generation);
    return waiting;
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
  // changes nothing; a duplicate never restarts an admitted one. An export
  // that finished after its window ends the import instead.
  async start(bulkOperationId: string) {
    const expired = await this.ctx.storage.transaction(async (transaction) => {
      const job = await transaction.get<CatalogImportJob>("job");
      if (job?.bulkOperationId !== bulkOperationId || !resumable(job))
        return null;
      if (job.admitted) {
        // A lost alarm is rearmed, a pending backoff is kept.
        if ((await transaction.getAlarm()) === null)
          await transaction.setAlarm(Date.now());
        return null;
      }
      if (
        Date.now() >=
        job.queuedAt + CATALOG_EXPORT_WINDOW_MS + CATALOG_EXPORT_POLL_MS
      ) {
        await this.end(transaction, "EXPORT_EXPIRED");
        return job;
      }
      await transaction.put<CatalogImportJob>("job", {
        ...job,
        admitted: true,
        admittedAt: Date.now(),
      });
      await transaction.setAlarm(Date.now());
      return null;
    });
    if (expired) await this.release(expired.shop, expired.generation);
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

  // Shopify reads share the coordinator's serialized offline token refresh.
  private shopify(shop: string): GraphqlRequestFn {
    return (query, variables) =>
      this.env.SHOP_COORDINATOR.getByName(shop.toLowerCase()).graphql(
        shop,
        query,
        variables,
      );
  }

  // The outcome and the end of the job commit together, and only while this
  // generation is current.
  private async finish(job: CatalogImportJob, progress: Progress) {
    const status = stamp(progress);
    if (
      !(await this.whileCurrent(job, async (transaction) => {
        await transaction.delete("job");
        await transaction.deleteAlarm();
        await transaction.put("status", status);
      }))
    )
      return;
    await this.release(job.shop, job.generation);
    console.log(
      `Catalog import ${status.phase} for ${job.shop}: ${status.total} products, ${status.eligible ?? 0} published to Aura, ${status.withdrawn ?? 0} withdrawn, ${status.failed} failures${status.error ? ` (${status.error})` : ""}`,
    );
  }

  // Shopify is still exporting. A finished or failed export is handled as
  // its webhook would handle it, so a lost delivery delays the import by one
  // check at most. Only a check that reads the export as running keeps the
  // queued status current; failing checks let it read as failed after an
  // hour while checking continues. An export that has not completed by the
  // last check, at the end of its window, ends the import and is cancelled.
  private async awaitExport(job: CatalogImportJob) {
    const deadline = job.queuedAt + CATALOG_EXPORT_WINDOW_MS;
    const shopify = this.shopify(job.shop);
    let state: BulkOperationState | null = null;
    try {
      state = await readBulkOperationState(shopify, job.bulkOperationId);
    } catch (error) {
      console.warn(
        `Catalog export of ${job.shop} could not be checked:`,
        (error instanceof Error ? error.message : String(error)).slice(0, 180),
      );
    }
    if (state === "completed") return this.start(job.bulkOperationId);
    if (state === "failed") return this.exportFailed(job.bulkOperationId);
    const expired = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<CatalogImportJob>("job");
      if (current?.generation !== job.generation || current.admitted)
        return false;
      if (Date.now() >= deadline) {
        await this.end(transaction, "EXPORT_EXPIRED");
        return true;
      }
      if (state === "running")
        await transaction.put(
          "status",
          stamp({ phase: "queued", total: 0, failed: 0 }),
        );
      await transaction.setAlarm(
        Math.min(Date.now() + CATALOG_EXPORT_POLL_MS, deadline),
      );
      return false;
    });
    if (!expired) return;
    await this.release(job.shop, job.generation);
    await cancelBulkOperation(shopify, job.bulkOperationId).catch(() =>
      console.warn(`Expired catalog export of ${job.shop} was not cancelled`),
    );
  }

  // A generation awaiting its channel publication checks it again. It exports
  // as soon as Shopify returns the publication, ends at once with missing
  // access or a missing or foreign connection, and reports what Shopify last
  // returned once its window closed. It never exports without the
  // publication. A missing context is awaited like a failed read.
  private async checkPublication(setup: CatalogSetupJob) {
    const deadline = setup.since + CATALOG_SETUP_WINDOW_MS;
    const context = await loadCatalogSetupContext(
      this.env.KV,
      setup.shop,
      setup.generation,
    ).catch(() => null);
    const publication =
      context?.listingSourceId === setup.listingSourceId
        ? await resolveChannelPublication(
            this.shopify(setup.shop),
            setup.listingSourceId,
          )
        : null;
    if (context && publication?.state === "ready")
      return this.exportPublication(setup, context, publication.publicationId);
    const state: ChannelPublicationState =
      publication && publication.state !== "ready"
        ? publication.state
        : "unavailable";
    const error = CHANNEL_PUBLICATION_ERRORS[state];
    if (!awaitsChannelPublication(state) || Date.now() >= deadline) {
      if (await this.fail(setup.generation, error))
        console.warn(
          `Backfill not submitted for ${setup.shop}: publication ${state} after ${setup.checks + 1} checks`,
        );
      return;
    }
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<CatalogSetupJob>("setup");
      if (current?.generation !== setup.generation) return;
      const checks = current.checks + 1;
      await transaction.put<CatalogSetupJob>("setup", {
        ...current,
        checks,
        error,
      });
      await transaction.setAlarm(
        Math.min(Date.now() + catalogSetupDelay(checks), deadline),
      );
    });
  }

  // Submits the channel-filtered export once the publication is readable,
  // exactly as an import that found it at once. A failed submission is
  // reported, as it is there.
  private async exportPublication(
    setup: CatalogSetupJob,
    context: CatalogSetupContext,
    publicationId: string,
  ) {
    const failed = async (error: unknown) => {
      console.error(
        `Failed to submit backfill for ${setup.shop}:`,
        (error instanceof Error ? error.message : String(error))
          .replaceAll(context.accessToken, "[redacted]")
          .replace(/\s+/g, " ")
          .slice(0, 180),
      );
      await this.fail(setup.generation, "SHOPIFY_READ_FAILED");
    };
    // A generation retired during the check exports nothing.
    if (
      (await this.ctx.storage.get<CatalogSetupJob>("setup"))?.generation !==
      setup.generation
    )
      return;
    let bulkOperationId: string;
    try {
      bulkOperationId = await submitBulkOperation(
        this.shopify(setup.shop),
        publicationId,
      );
    } catch (error) {
      return failed(error);
    }
    try {
      // Retired during the submission, the export is discarded and its
      // completion admits nothing.
      if (
        await this.queue(setup.generation, {
          ...context,
          bulkOperationId,
          publicationId,
          createdAt: new Date().toISOString(),
        })
      )
        console.log(
          `Backfill bulk operation submitted for ${setup.shop} after ${setup.checks + 1} publication checks: ${bulkOperationId}`,
        );
      else
        console.warn(`Backfill for ${setup.shop} was retired before queueing`);
    } catch (error) {
      await failed(error);
    }
  }

  async alarm() {
    const setup = await this.ctx.storage.get<CatalogSetupJob>("setup");
    if (setup) return this.checkPublication(setup);
    const job = await this.ctx.storage.get<CatalogImportJob>("job");
    if (!job) return;
    if (!resumable(job)) {
      if (job.admitted)
        await this.finish(job, {
          phase: "failed",
          total: 0,
          failed: 0,
          error: "INCOMPLETE_EXPORT",
        });
      return;
    }
    if (!job.admitted) return this.awaitExport(job);
    if (
      Date.now() >=
      (job.admittedAt ?? job.queuedAt) + CATALOG_IMPORT_WINDOW_MS
    )
      return this.finish(job, {
        phase: "failed",
        ...catalogProgress(job),
        error: "IMPORT_EXPIRED",
      });
    const graphql = this.shopify(job.shop);
    const { offset, part } = job;
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
      // A step that moved on before it failed starts its retries afresh.
      job.attempts =
        job.offset !== offset || job.part !== part ? 1 : job.attempts + 1;
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
      // What was already submitted is reported with the failure.
      step = {
        done: true,
        status: {
          phase: "failed",
          ...catalogProgress(job),
          error: "SHOPIFY_READ_FAILED",
        },
      };
    }
    if (!step.done) {
      const status = stamp(step.status);
      await this.whileCurrent(job, async (transaction) => {
        await transaction.put("job", job);
        await transaction.put("status", status);
        await transaction.setAlarm(Date.now() + 1000);
      });
      return;
    }
    await this.finish(job, step.status);
  }
}
