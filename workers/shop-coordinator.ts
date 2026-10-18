import { DurableObject } from "cloudflare:workers";
import { GraphqlQueryError } from "@shopify/shopify-api";
import { SessionNotFoundError } from "@shopify/shopify-app-react-router/server";
import type { GraphqlRequestFn } from "../app/backfill.server";
import { getAuraHistoriaApiBaseUrl } from "../app/oauth.server";
import {
  acquireShippingStep,
  beginAcquisition,
  type ShippingAcquisitionState,
} from "../app/shipping/acquisition.server";
import { mapShipping } from "../app/shipping/mapper";
import {
  profileObjectKey,
  SHIPPING_API_VERSION,
  ShippingReadError,
} from "../app/shipping/model";
import {
  addConfirmedRemovals,
  beginPublication,
  type Publication,
  publishShippingStep,
  type ResourceMapping,
  readyPublicationWork,
} from "../app/shipping/publisher.server";
import { loadShopCredentials } from "../app/shop-credentials.server";
import {
  type CloudflareShopifyEnv,
  getShopifyForEnv,
} from "../app/shopify.server";

export interface ShippingStatus {
  phase:
    | "idle"
    | "queued"
    | "acquiring"
    | "publishing"
    | "partial"
    | "applied"
    | "blocked";
  committed: number;
  pending: number;
  protected: number;
  failures: number;
  limitations: string[];
  error?: string;
  acquiredAt?: string;
}
interface Job {
  shop: string;
  listingSourceId: string;
  credentialVersion: string;
  sequence: number;
  runId: string;
  acquisition?: ShippingAcquisitionState;
  publication?: Publication;
  refreshRequested: boolean;
  attempts: number;
}
interface CoordinatorState {
  sequence: number;
  mappings: Record<string, ResourceMapping>;
  source?: string;
  job?: Job;
  status: ShippingStatus;
}

const idle = (): ShippingStatus => ({
  phase: "idle",
  committed: 0,
  pending: 0,
  protected: 0,
  failures: 0,
  limitations: [],
});

function nextSequence(state: CoordinatorState) {
  // Keep acquisition order after uninstall erasure/reinstallation as well as
  // across concurrent wake-ups. Values remain exact JS integers at this epoch.
  state.sequence = Math.max(state.sequence + 1, Date.now() * 1000);
  return state.sequence;
}

export class ShopCoordinator extends DurableObject<CloudflareShopifyEnv> {
  // Serialize I/O within the shop, including the SDK-owned refresh operation.
  // Persistent requests/checkpoints survive eviction; the mutex holds no data.
  private tail: Promise<unknown> = Promise.resolve();

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<CoordinatorState> {
    const count = await this.ctx.storage.get<number>("chunks");
    if (!count) return { sequence: 0, mappings: {}, status: idle() };
    const keys = Array.from({ length: count }, (_, i) => `state:${i}`);
    const chunks: string[] = [];
    for (let i = 0; i < keys.length; i += 64) {
      const batch = keys.slice(i, i + 64);
      const values = await this.ctx.storage.get<string>(batch);
      chunks.push(...batch.map((key) => values.get(key) ?? ""));
    }
    return JSON.parse(chunks.join(""));
  }

  private async save(state: CoordinatorState) {
    const json = JSON.stringify(state);
    const chunks: Record<string, string | number> = {};
    for (let i = 0; i < json.length; i += 25_000)
      chunks[`state:${i / 25_000}`] = json.slice(i, i + 25_000);
    chunks.chunks = Math.ceil(json.length / 25_000);
    // All parts and the manifest commit together, before sending a pending write.
    // Remove old tail chunks so completed snapshots are not retained privately.
    await this.ctx.storage.transaction(async (transaction) => {
      const previous = (await transaction.get<number>("chunks")) ?? 0;
      const entries = Object.entries(chunks);
      for (let i = 0; i < entries.length; i += 64) {
        await transaction.put(Object.fromEntries(entries.slice(i, i + 64)));
      }
      const excess = Array.from(
        { length: Math.max(0, previous - Number(chunks.chunks)) },
        (_, i) => `state:${Number(chunks.chunks) + i}`,
      );
      for (let i = 0; i < excess.length; i += 64)
        await transaction.delete(excess.slice(i, i + 64));
    });
  }

  protected async providerGraphql(
    shop: string,
    query: string,
    variables?: Record<string, unknown>,
    shipping = false,
  ) {
    // The SDK loads the protected current session, refreshes expiring offline
    // access and saves it through the existing KVSessionStorage implementation.
    try {
      const { admin } = await getShopifyForEnv(this.env).unauthenticated.admin(
        shop,
      );
      const response = await admin.graphql(query, { variables });
      // The React Router SDK serializes API headers into the response body;
      // its synthetic Response has none of Shopify's upstream headers.
      const body = (await response.json()) as Awaited<
        ReturnType<GraphqlRequestFn>
      > & { headers?: Record<string, string> };
      if (
        shipping &&
        new Headers(body.headers).get("X-Shopify-API-Version") !==
          SHIPPING_API_VERSION
      ) {
        throw new ShippingReadError("UNSUPPORTED_SHOPIFY_API_VERSION");
      }
      return body;
    } catch (error) {
      if (shipping && error instanceof GraphqlQueryError) {
        // The SDK throws GraphQL errors before returning a Response. Feed only
        // the typed errors back to acquisition, including scope denials.
        return { errors: error.body?.errors?.graphQLErrors };
      }
      if (shipping && error instanceof SessionNotFoundError) {
        throw new ShippingReadError("SHOPIFY_OFFLINE_ACCESS_REQUIRED");
      }
      throw error;
    }
  }

  async graphql(
    shop: string,
    query: string,
    variables?: Record<string, unknown>,
  ) {
    return this.serialize(async () => {
      return this.providerGraphql(shop, query, variables);
    });
  }

  async status(): Promise<ShippingStatus> {
    return this.serialize(async () => (await this.load()).status);
  }

  async requestShipping(shop: string) {
    return this.serialize(async () => {
      const credentials = await loadShopCredentials(this.env.KV, shop);
      if (!credentials) return false;
      const state = await this.load();
      if (
        state.job &&
        state.job.listingSourceId === credentials.listingSourceId &&
        state.job.credentialVersion === credentials.updatedAt
      ) {
        state.job.refreshRequested = true;
      } else {
        if (state.source !== credentials.listingSourceId) state.mappings = {};
        state.source = credentials.listingSourceId;
        nextSequence(state);
        state.job = {
          shop,
          listingSourceId: credentials.listingSourceId,
          credentialVersion: credentials.updatedAt,
          sequence: state.sequence,
          runId: crypto.randomUUID(),
          acquisition: beginAcquisition(new Date().toISOString()),
          refreshRequested: false,
          attempts: 0,
        };
        state.status = { ...idle(), phase: "queued" };
      }
      // Arm before persisting work, so a crash cannot leave accepted work asleep.
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      await this.save(state);
      return true;
    });
  }

  async cancel(erase = false) {
    return this.serialize(async () => {
      await this.ctx.storage.deleteAlarm();
      if (erase) await this.ctx.storage.deleteAll();
      else {
        const state = await this.load();
        state.job = undefined;
        state.status = idle();
        await this.save(state);
      }
    });
  }

  async alarm() {
    return this.serialize(async () => {
      const state = await this.load();
      const job = state.job;
      if (!job) return;
      // Persistent watchdog precedes external I/O. Retry even after a hard stop.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      const credentials = await loadShopCredentials(this.env.KV, job.shop);
      if (
        !credentials ||
        credentials.listingSourceId !== job.listingSourceId ||
        credentials.updatedAt !== job.credentialVersion
      ) {
        state.job = undefined;
        state.status = {
          ...state.status,
          phase: "blocked",
          error: "CONNECTION_CHANGED_REACQUIRE",
        };
        await this.save(state);
        await this.ctx.storage.deleteAlarm();
        return;
      }
      let delay = 1000;
      if (job.refreshRequested) {
        const pendingPublication = job.publication;
        const uncertain =
          pendingPublication?.work.filter(
            (work) => work.pending && !work.done,
          ) ?? [];
        if (pendingPublication && uncertain.length) {
          // Resolve persisted exact requests before starting a newer source
          // acquisition. Unprepared missing-listing work is superseded.
          pendingPublication.work = pendingPublication.work.filter(
            (work) => work.done || work.pending,
          );
        } else {
          job.refreshRequested = false;
          job.acquisition = beginAcquisition(new Date().toISOString());
          job.publication = undefined;
          job.runId = crypto.randomUUID();
          job.sequence = nextSequence(state);
          job.attempts = 0;
          state.status = { ...idle(), phase: "queued" };
        }
      }
      try {
        if (job.acquisition) {
          state.status.phase = "acquiring";
          // A failed request must retain its original task/cursor.
          const next = structuredClone(job.acquisition);
          await acquireShippingStep(next, (query, variables) =>
            this.providerGraphql(job.shop, query, variables, true),
          );
          job.acquisition = next;
          if (next.tasks.length === 0) {
            const mapping = mapShipping(next.snapshot);
            state.status.limitations = mapping.limitations;
            state.status.acquiredAt = next.snapshot.acquiredAt;
            job.publication = beginPublication(
              mapping,
              job.runId,
              job.sequence,
              next.snapshot.acquiredAt,
              state.mappings,
            );
            addConfirmedRemovals(
              job.publication,
              Object.keys(next.snapshot.profiles).map(profileObjectKey),
            );
            job.acquisition = undefined;
          }
        } else if (job.publication) {
          const publication = job.publication;
          const apiBaseUrl = getAuraHistoriaApiBaseUrl(this.env);
          if (!apiBaseUrl)
            throw new ShippingReadError("AURA_CONFIGURATION_REQUIRED");
          // publishShippingStep alternates prepare/persist and send/checkpoint.
          await publishShippingStep(publication, {
            apiBaseUrl,
            listingSourceId: job.listingSourceId,
            accessToken: credentials.accessToken,
          });
          state.mappings = publication.mappings;
          const remaining = publication.work.filter((work) => !work.done);
          state.status = {
            ...state.status,
            phase: "publishing",
            committed: publication.committed,
            protected: publication.protected,
            failures: publication.failures,
            pending: remaining.length,
            error: publication.lastError,
          };
          if (publication.reconcile) {
            if (++job.attempts > 3)
              throw new ShippingReadError("RECONCILIATION_REQUIRED");
            job.acquisition = beginAcquisition(new Date().toISOString());
            job.publication = undefined;
            job.runId = crypto.randomUUID();
            job.sequence = nextSequence(state);
          } else if (!remaining.length) {
            state.status.phase =
              publication.failures || state.status.limitations.length
                ? "partial"
                : "applied";
            state.job = undefined;
            if (!publication.failures) state.status.error = undefined;
          } else {
            const earliest = Math.min(
              ...readyPublicationWork(publication).map((work) => work.dueAt),
            );
            if (earliest > Date.now()) {
              state.status.phase = "partial";
              delay = Math.max(1000, earliest - Date.now());
            }
          }
        }
      } catch (error) {
        const code =
          error instanceof ShippingReadError
            ? error.code
            : "SHIPPING_REQUEST_FAILED";
        state.status.error = code;
        if (code === "SHOPIFY_CHANGED_DURING_READ" && ++job.attempts <= 3) {
          job.acquisition = beginAcquisition(new Date().toISOString());
          job.runId = crypto.randomUUID();
          job.sequence = nextSequence(state);
        } else if (
          code === "SHOPIFY_READ_FAILED" ||
          code === "SHIPPING_REQUEST_FAILED"
        ) {
          state.status.phase = "partial";
          delay = Math.min(3600_000, 1000 * 2 ** Math.min(++job.attempts, 12));
        } else {
          state.status.phase = "blocked";
          state.job = undefined;
        }
      }
      const refresh = !state.job && job.refreshRequested;
      if (refresh) {
        job.refreshRequested = false;
        job.acquisition = beginAcquisition(new Date().toISOString());
        job.publication = undefined;
        job.runId = crypto.randomUUID();
        job.sequence = nextSequence(state);
        job.attempts = 0;
        state.job = job;
      }
      await this.save(state);
      if (state.job) await this.ctx.storage.setAlarm(Date.now() + delay);
      else await this.ctx.storage.deleteAlarm();
    });
  }
}
