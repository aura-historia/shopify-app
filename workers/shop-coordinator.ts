import { DurableObject } from "cloudflare:workers";
import {
  GraphqlQueryError,
  HttpResponseError,
  InvalidJwtError,
} from "@shopify/shopify-api";
import { SessionNotFoundError } from "@shopify/shopify-app-react-router/server";
import type { GraphqlRequestFn } from "../app/backfill.server";
import {
  getAuraHistoriaApiBaseUrl,
  getAuraHistoriaOAuthConfig,
  getMissingAuraHistoriaOAuthConfig,
  revokeAuraHistoriaAccessToken,
} from "../app/oauth.server";
import {
  acquireShippingStep,
  beginAcquisition,
  type ShippingAcquisitionState,
} from "../app/shipping/acquisition.server";
import { mapShipping, observedProfileKeys } from "../app/shipping/mapper";
import {
  SHIPPING_API_VERSION,
  SHIPPING_LIMITS,
  ShippingReadError,
} from "../app/shipping/model";
import {
  addConfirmedMembershipRemovals,
  addConfirmedRemovals,
  beginPublication,
  beginWithdrawal,
  type Publication,
  publishShippingStep,
  type ResourceMapping,
  readyPublicationWork,
} from "../app/shipping/publisher.server";
import {
  hintResource,
  SHIPPING_TOPICS,
  type ShippingHint,
} from "../app/shipping/webhooks.server";
import {
  clearShopCredentialsDisconnected,
  credentialVersion,
  isShopCredentialsDisconnected,
  loadShopCredentials,
  type ShopCredentialsRecord,
  type ShopCredentialsValues,
  saveShopCredentials,
} from "../app/shop-credentials.server";
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
  nextReconciliationAt?: string;
  cleanup?: "pending" | "committed" | "unconfirmed";
  tokenRevoked?: boolean;
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
  failures?: number;
  paused?: boolean;
}
interface CleanupJob {
  shop: string;
  listingSourceId: string;
  credentialVersion: string;
  credentialKey: string;
  publication: Publication;
  deadline: number;
  attempts: number;
  erase: boolean;
  revoke: boolean;
}
interface CoordinatorState {
  sequence: number;
  mappings: Record<string, ResourceMapping>;
  source?: string;
  job?: Job;
  status: ShippingStatus;
  binding?: {
    shop: string;
    listingSourceId: string;
    credentialVersion: string;
  };
  stopped?: boolean;
  seenHintVersion?: number;
  eraseAt?: number;
  memberships?: string[];
  lastAcquiredAt?: string;
  reconcileAt?: number;
  cleanup?: CleanupJob;
  cleanupQueue?: CleanupJob[];
  cleanupHadFailure?: boolean;
}

export const RECONCILIATION_INTERVAL = 6 * 3600_000;
const PRIVATE_RETENTION = 7 * 86_400_000;
const DELIVERY_RETENTION = 48 * 3600_000;
const cleanupJobs = (state: CoordinatorState) =>
  [state.cleanup, ...(state.cleanupQueue ?? [])].filter(
    (job): job is CleanupJob => Boolean(job),
  );
// The protected record stays readable until a disconnect, uninstall or new
// authorization replaces it. A stopped binding of the same version, or its
// queued revocation, means it no longer acts for the shop: nothing revives it.
const retired = (state: CoordinatorState, version: string) =>
  Boolean(state.stopped && state.binding?.credentialVersion === version) ||
  cleanupJobs(state).some(
    (job) => job.revoke && job.credentialVersion === version,
  );

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

function rememberPublication(state: CoordinatorState) {
  const publication = state.job?.publication;
  if (!publication) return;
  state.lastAcquiredAt = publication.acquiredAt;
  const memberships = new Set(state.memberships ?? []);
  for (const work of publication.work) {
    if (work.resource.kind === "profile")
      state.mappings[work.key] ??= {
        id: "",
        providerId: work.resource.value.providerId,
      };
    if (work.resource.kind === "membership")
      memberships.add(work.resource.value.sourceListingId);
  }
  state.memberships = [...memberships];
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
    chunks.admission = JSON.stringify({
      binding: state.binding,
      stopped: state.stopped,
    });
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

  private async schedule(state: CoordinatorState, when: number) {
    await this.ctx.storage.transaction(async (transaction) => {
      const hinted = (await transaction.get<number>("hintVersion")) ?? 0;
      await transaction.setAlarm(
        hinted > (state.seenHintVersion ?? 0) ? Date.now() + 1000 : when,
      );
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
      const response = await admin.graphql(query, {
        variables,
        signal: AbortSignal.timeout(20_000),
      });
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
      if (
        shipping &&
        (error instanceof SessionNotFoundError ||
          error instanceof InvalidJwtError ||
          (error instanceof HttpResponseError &&
            (error.response.code === 401 ||
              (error.response.code === 400 &&
                error.response.body?.error === "invalid_subject_token"))))
      ) {
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
    return this.serialize(async () => {
      const state = await this.load();
      const hinted = (await this.ctx.storage.get<number>("hintVersion")) ?? 0;
      return !state.stopped &&
        state.binding &&
        hinted > (state.seenHintVersion ?? 0)
        ? { ...state.status, phase: "queued" }
        : state.status;
    });
  }

  async requestShipping(shop: string) {
    return this.serialize(async () => {
      const credentials = await loadShopCredentials(this.env.KV, shop);
      if (
        !credentials ||
        (await isShopCredentialsDisconnected(this.env.KV, shop))
      )
        return false;
      const state = await this.load();
      if (retired(state, credentialVersion(credentials))) return false;
      if (
        state.job?.publication?.retainUntil &&
        state.job.publication.retainUntil <= Date.now()
      ) {
        rememberPublication(state);
        state.job = undefined;
      }
      this.enqueue(state, shop, credentials, true);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      await this.save(state);
      return true;
    });
  }

  private enqueue(
    state: CoordinatorState,
    shop: string,
    credentials: ShopCredentialsRecord,
    resume: boolean,
  ) {
    state.stopped = false;
    state.binding = {
      shop,
      listingSourceId: credentials.listingSourceId,
      credentialVersion: credentialVersion(credentials),
    };
    state.reconcileAt ??= Date.now() + RECONCILIATION_INTERVAL;
    if (
      state.job &&
      state.job.listingSourceId === credentials.listingSourceId &&
      state.job.credentialVersion === credentialVersion(credentials)
    ) {
      state.job.refreshRequested = true;
      if (resume) {
        state.job.paused = false;
        state.job.attempts = 0;
        state.job.failures = 0;
      }
      for (const work of resume ? (state.job.publication?.work ?? []) : []) {
        if (!work.done) {
          work.attempts = 0;
          work.exhausted = false;
          work.dueAt = 0;
        }
      }
      state.status.phase = "queued";
      state.status.error = undefined;
    } else {
      if (state.source !== credentials.listingSourceId) {
        state.mappings = {};
        state.memberships = [];
        state.lastAcquiredAt = undefined;
      }
      state.source = credentials.listingSourceId;
      nextSequence(state);
      state.job = {
        shop,
        listingSourceId: credentials.listingSourceId,
        credentialVersion: credentialVersion(credentials),
        sequence: state.sequence,
        runId: crypto.randomUUID(),
        acquisition: beginAcquisition(new Date().toISOString()),
        refreshRequested: false,
        attempts: 0,
      };
      state.status = {
        ...idle(),
        cleanup: state.status.cleanup,
        tokenRevoked: state.status.tokenRevoked,
        phase: "queued",
      };
    }
    state.status.nextReconciliationAt = new Date(
      state.reconcileAt,
    ).toISOString();
  }

  async admitShippingHint(shop: string, hint: ShippingHint) {
    const resource = SHIPPING_TOPICS.includes(hint.topic)
      ? hintResource(hint.topic)
      : undefined;
    if (
      resource === undefined ||
      !/^[A-Za-z0-9-]{1,128}$/.test(hint.deliveryId) ||
      (resource !== null &&
        !new RegExp(`^gid://shopify/${resource}/[1-9]\\d*$`).test(
          hint.resourceId ?? "",
        ))
    )
      throw new Error("INVALID_SHIPPING_HINT");
    const credentials = await loadShopCredentials(this.env.KV, shop);
    if (
      !credentials ||
      (await isShopCredentialsDisconnected(this.env.KV, shop))
    )
      return false;
    // Admission uses its own durable inbox, so a 20-second provider call in
    // the worker cannot hold up the webhook's acknowledgement. Transactions
    // serialize it with connection fences and alarm scheduling.
    return this.ctx.storage.transaction(async (transaction) => {
      const raw = await transaction.get<string>("admission");
      const admission = raw
        ? (JSON.parse(raw) as Pick<CoordinatorState, "binding" | "stopped">)
        : undefined;
      const binding = admission?.binding;
      if (
        !binding ||
        admission?.stopped ||
        binding.shop !== shop ||
        credentials.listingSourceId !== binding.listingSourceId ||
        credentialVersion(credentials) !== binding.credentialVersion
      )
        return false;
      const now = Date.now();
      const stored = await transaction.get<{
        binding: string;
        deliveries: Record<string, number>;
      }>("receipts");
      const namespace = `${binding.listingSourceId}:${binding.credentialVersion}`;
      const deliveries = Object.fromEntries(
        Object.entries(
          stored?.binding === namespace ? stored.deliveries : {},
        ).filter(([, time]) => time > now - DELIVERY_RETENTION),
      );
      const key = `${hint.topic}:${hint.deliveryId}`;
      if (deliveries[key]) return true;
      // A full deduplication window applies backpressure instead of silently
      // dropping delivery receipts that Shopify might still retry.
      if (Object.keys(deliveries).length >= 512)
        throw new Error("SHIPPING_ADMISSION_FULL");
      deliveries[key] = now;
      const version = ((await transaction.get<number>("hintVersion")) ?? 0) + 1;
      await transaction.put({
        receipts: { binding: namespace, deliveries },
        hintVersion: version,
        ...(hint.topic === "APP_SCOPES_UPDATE"
          ? { scopeVersion: version }
          : {}),
      });
      await transaction.setAlarm(now + 1000);
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
        state.stopped = true;
        state.reconcileAt = undefined;
        state.status = idle();
        await this.save(state);
      }
    });
  }

  // Whether the caller's record is one this coordinator stopped or revokes.
  // It checks the version the caller is about to use, not a fresh KV read.
  async connectionRetired(version: string) {
    return this.serialize(async () => retired(await this.load(), version));
  }

  // Called by the OAuth callback only after the new grant configured the
  // provider. The current record and binding stay untouched until the new
  // record is stored, so a failed replacement leaves them running. The old
  // binding's stop, cleanup and revocation then commit with the new binding
  // in this one serialized step, and overlapping callbacks each replace
  // whichever connection is current when they run.
  async saveConnection(shop: string, values: ShopCredentialsValues) {
    return this.serialize(async () => {
      const state = await this.load();
      const hinted = (await this.ctx.storage.get<number>("hintVersion")) ?? 0;
      const previous = await loadShopCredentials(this.env.KV, shop);
      // Every replaced grant that is not already fenced is withdrawn and
      // revoked, bound or not. Its token is copied to cleanup storage before
      // the record holding it is overwritten.
      const cleanup =
        previous && !retired(state, credentialVersion(previous))
          ? await this.startCleanup(state, shop, previous, false, true)
          : undefined;
      let record: ShopCredentialsRecord;
      // The caller revokes the new grant when this throws, so all fallible KV
      // writes precede the record. Authorizing again ends a manual pause.
      try {
        await clearShopCredentialsDisconnected(this.env.KV, shop);
        record = await saveShopCredentials(this.env.KV, shop, values);
      } catch (error) {
        // No record was replaced; the previous binding keeps its work.
        if (cleanup)
          await this.env.KV.delete(cleanup.credentialKey).catch(() => {});
        throw error;
      }
      state.job = undefined;
      state.reconcileAt = undefined;
      state.seenHintVersion = hinted;
      // A reconnect always performs new acquisition, never relabels old data.
      this.enqueue(state, shop, record, true);
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      await this.save(state);
      return record;
    });
  }

  private async startCleanup(
    state: CoordinatorState,
    shop: string,
    credentials: ShopCredentialsRecord,
    erase: boolean,
    revoke: boolean,
  ) {
    const existing = cleanupJobs(state).find(
      (job) =>
        job.listingSourceId === credentials.listingSourceId &&
        job.credentialVersion === credentialVersion(credentials),
    );
    if (existing) {
      existing.erase ||= erase;
      existing.revoke ||= revoke;
      return;
    }
    if ((state.cleanupQueue?.length ?? 0) >= 4)
      throw new Error("SHIPPING_CLEANUP_CAPACITY");
    const mappings = { ...state.mappings };
    const memberships = new Set(state.memberships ?? []);
    for (const work of state.job?.publication?.work ?? []) {
      if (work.resource.kind === "profile") {
        // A create may have committed without returning its ID. Resolve the
        // stable object identity in the cleanup worker before retiring it.
        mappings[work.key] ??= {
          id: "",
          providerId: work.resource.value.providerId,
        };
      }
      if (work.resource.kind === "membership")
        memberships.add(work.resource.value.sourceListingId);
    }
    const now = Date.now();
    const credentialKey = `aura-historia:shipping-cleanup:${shop}:${crypto.randomUUID()}`;
    // Only Aura credentials are retained in protected KV, never in job state.
    await this.env.KV.put(credentialKey, JSON.stringify(credentials), {
      expirationTtl: PRIVATE_RETENTION / 1000,
    });
    const cleanup: CleanupJob = {
      shop,
      listingSourceId: credentials.listingSourceId,
      credentialVersion: credentialVersion(credentials),
      credentialKey,
      deadline: now + PRIVATE_RETENTION,
      attempts: 0,
      erase,
      revoke,
      publication: beginWithdrawal(
        mappings,
        [...memberships],
        crypto.randomUUID(),
        nextSequence(state),
        state.job?.publication?.acquiredAt ??
          state.lastAcquiredAt ??
          state.status.acquiredAt ??
          new Date(now).toISOString(),
      ),
    };
    if (state.cleanup) {
      state.cleanupQueue ??= [];
      state.cleanupQueue.push(cleanup);
    } else state.cleanup = cleanup;
    state.job = undefined;
    state.status.cleanup = "pending";
    state.status.tokenRevoked = false;
    return cleanup;
  }

  async disconnectShipping(shop: string, erase = false) {
    return this.serialize(async () => {
      const state = await this.load();
      // The stop commits before any external cleanup. Unknown/late callbacks
      // cannot reopen this binding even if KV returns an older connection.
      state.stopped = true;
      state.eraseAt = Date.now() + PRIVATE_RETENTION;
      state.reconcileAt = undefined;
      state.status.nextReconciliationAt = undefined;
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      await this.save(state);
      const credentials = await loadShopCredentials(this.env.KV, shop);
      if (credentials)
        await this.startCleanup(state, shop, credentials, erase, true);
      if (state.cleanup) state.cleanup.erase ||= erase;
      state.job = undefined;
      state.status.phase = "blocked";
      state.status.error = "SHIPPING_LOCALLY_STOPPED";
      if (
        !credentials &&
        !state.cleanup &&
        state.status.cleanup !== "committed"
      )
        state.status.cleanup = "unconfirmed";
      await this.save(state);
      return state.status;
    });
  }

  private async cleanupStep(state: CoordinatorState) {
    const cleanup = state.cleanup;
    if (!cleanup) return;
    const now = Date.now();
    const storedCredentials = await this.env.KV.get<ShopCredentialsRecord>(
      cleanup.credentialKey,
      "json",
    );
    const credentials =
      storedCredentials?.listingSourceId === cleanup.listingSourceId &&
      credentialVersion(storedCredentials) === cleanup.credentialVersion
        ? storedCredentials
        : null;
    const apiBaseUrl = getAuraHistoriaApiBaseUrl(this.env);
    const publication = cleanup.publication;
    if (credentials && apiBaseUrl && now < cleanup.deadline) {
      try {
        await publishShippingStep(publication, {
          apiBaseUrl,
          listingSourceId: credentials.listingSourceId,
          accessToken: credentials.accessToken,
        });
        cleanup.attempts = 0;
      } catch {
        cleanup.attempts++;
      }
    }
    const remaining = publication.work.some((work) => !work.done);
    const ready = readyPublicationWork(publication);
    if (
      credentials &&
      apiBaseUrl &&
      now < cleanup.deadline &&
      remaining &&
      ready.length &&
      cleanup.attempts < SHIPPING_LIMITS.retries &&
      !publication.reconcile
    ) {
      await this.save(state);
      await this.ctx.storage.setAlarm(
        Math.max(
          now + 1000 * 2 ** cleanup.attempts,
          Math.min(...ready.map((work) => work.dueAt)),
        ),
      );
      return;
    }
    if (remaining || publication.failures || publication.reconcile)
      state.cleanupHadFailure = true;
    state.status.cleanup = state.cleanupHadFailure
      ? "unconfirmed"
      : state.cleanupQueue?.length
        ? "pending"
        : "committed";
    // Persist confirmed removals before revoking the credential used to prove
    // them. A restart must not turn known commits into failed replays with a
    // now-revoked token.
    await this.save(state);
    if (cleanup.revoke && credentials) {
      const config = getAuraHistoriaOAuthConfig(this.env);
      if (getMissingAuraHistoriaOAuthConfig(config).length === 0) {
        try {
          await revokeAuraHistoriaAccessToken(config, credentials.accessToken);
          state.status.tokenRevoked = true;
        } catch {
          state.status.tokenRevoked = false;
        }
      }
    }
    await this.save(state);
    await this.env.KV.delete(cleanup.credentialKey);
    if (cleanup.erase) {
      state.mappings = {};
      state.memberships = [];
    }
    state.cleanup = state.cleanupQueue?.shift();
    if (state.status.cleanup === "unconfirmed")
      state.status.error = "SHIPPING_CLEANUP_UNCONFIRMED";
    await this.save(state);
    if (state.cleanup || state.job) await this.schedule(state, now + 1000);
    else if (!state.stopped && state.reconcileAt)
      await this.schedule(state, state.reconcileAt);
    else
      await this.ctx.storage.setAlarm(state.eraseAt ?? now + PRIVATE_RETENTION);
  }

  async alarm() {
    return this.serialize(async () => {
      const state = await this.load();
      if (state.cleanup) {
        await this.ctx.storage.setAlarm(Date.now() + 60_000);
        await this.cleanupStep(state);
        return;
      }
      if (state.stopped) {
        // Minimal stop/status tombstones outlive uninstall cleanup for seven
        // days. Hints require a binding and can never recreate erased state.
        if (state.eraseAt && state.eraseAt > Date.now()) {
          await this.ctx.storage.setAlarm(state.eraseAt);
          return;
        }
        // Erasure would lift the fence of a record that is still stored. Keep
        // only that fence and its status, as private state is erased on time.
        // Disconnect, uninstall or a new authorization wakes this again.
        const credentials =
          state.binding &&
          (await loadShopCredentials(this.env.KV, state.binding.shop));
        if (credentials && retired(state, credentialVersion(credentials))) {
          await this.save({
            sequence: state.sequence,
            mappings: {},
            binding: state.binding,
            stopped: true,
            status: state.status,
          });
          await this.ctx.storage.delete(["receipts"]);
          await this.ctx.storage.deleteAlarm();
          return;
        }
        await this.ctx.storage.deleteAll();
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const hinted = (await this.ctx.storage.get<number>("hintVersion")) ?? 0;
      if (state.binding && hinted > (state.seenHintVersion ?? 0)) {
        const scopeChanged =
          ((await this.ctx.storage.get<number>("scopeVersion")) ?? 0) >
          (state.seenHintVersion ?? 0);
        state.seenHintVersion = hinted;
        const credentials = await loadShopCredentials(
          this.env.KV,
          state.binding.shop,
        );
        if (
          credentials &&
          credentials.listingSourceId === state.binding.listingSourceId &&
          credentialVersion(credentials) === state.binding.credentialVersion
        ) {
          if (scopeChanged || state.job?.paused) {
            // Scope notifications fence previously prepared writes before any
            // replay. Remember ambiguous identities for a fresh comparison or
            // owned withdrawal, then verify current access through S01.
            rememberPublication(state);
            state.job = undefined;
          }
          this.enqueue(state, state.binding.shop, credentials, false);
        }
      }
      if (
        (!state.job || state.job.paused) &&
        state.binding &&
        state.reconcileAt &&
        state.reconcileAt <= Date.now()
      ) {
        const credentials = await loadShopCredentials(
          this.env.KV,
          state.binding.shop,
        );
        if (
          credentials &&
          credentials.listingSourceId === state.binding.listingSourceId &&
          credentialVersion(credentials) === state.binding.credentialVersion
        ) {
          rememberPublication(state);
          state.job = undefined;
          state.reconcileAt = Date.now() + RECONCILIATION_INTERVAL;
          this.enqueue(state, state.binding.shop, credentials, false);
          await this.ctx.storage.setAlarm(Date.now() + 1000);
          await this.save(state);
        } else {
          state.stopped = true;
          state.eraseAt = Date.now() + PRIVATE_RETENTION;
          rememberPublication(state);
          state.job = undefined;
          state.status.cleanup = "unconfirmed";
          state.status.error = "CONNECTION_CHANGED_REACQUIRE";
          state.status.phase = "blocked";
          await this.save(state);
          await this.ctx.storage.setAlarm(state.eraseAt);
          return;
        }
      }
      const job = state.job;
      if (!job) {
        if (state.reconcileAt)
          await this.ctx.storage.setAlarm(state.reconcileAt);
        return;
      }
      if (job.paused) {
        if (state.reconcileAt)
          await this.ctx.storage.setAlarm(state.reconcileAt);
        else await this.ctx.storage.deleteAlarm();
        return;
      }
      // Persistent watchdog precedes external I/O. Retry even after a hard stop.
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      const credentials = await loadShopCredentials(this.env.KV, job.shop);
      if (
        !credentials ||
        credentials.listingSourceId !== job.listingSourceId ||
        credentialVersion(credentials) !== job.credentialVersion
      ) {
        rememberPublication(state);
        state.job = undefined;
        state.stopped = true;
        state.eraseAt = Date.now() + PRIVATE_RETENTION;
        state.status = {
          ...state.status,
          phase: "blocked",
          error: "CONNECTION_CHANGED_REACQUIRE",
          cleanup: "unconfirmed",
        };
        await this.save(state);
        await this.ctx.storage.setAlarm(state.eraseAt);
        return;
      }
      let delay = 1000;
      if (job.refreshRequested || job.publication?.reconcile) {
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
          if (pendingPublication?.reconcile && ++job.attempts > 3) {
            job.paused = true;
            state.status.phase = "blocked";
            state.status.error = "RECONCILIATION_REQUIRED";
            await this.save(state);
            if (state.reconcileAt)
              await this.ctx.storage.setAlarm(state.reconcileAt);
            else await this.ctx.storage.deleteAlarm();
            return;
          }
          job.refreshRequested = false;
          job.acquisition = beginAcquisition(new Date().toISOString());
          job.publication = undefined;
          job.runId = crypto.randomUUID();
          job.sequence = nextSequence(state);
          job.failures = 0;
          state.status = {
            ...idle(),
            cleanup: state.status.cleanup,
            tokenRevoked: state.status.tokenRevoked,
            nextReconciliationAt: state.status.nextReconciliationAt,
            phase: "queued",
          };
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
          job.failures = 0;
          state.status.error = undefined;
          if (next.tasks.length === 0) {
            const mapping = mapShipping(next.snapshot);
            state.status.limitations = mapping.limitations;
            state.status.acquiredAt = next.snapshot.acquiredAt;
            state.lastAcquiredAt = next.snapshot.acquiredAt;
            job.publication = beginPublication(
              mapping,
              job.runId,
              job.sequence,
              next.snapshot.acquiredAt,
              state.mappings,
            );
            addConfirmedRemovals(
              job.publication,
              observedProfileKeys(next.snapshot),
            );
            addConfirmedMembershipRemovals(
              job.publication,
              state.memberships ?? [],
              mapping.memberships.map(
                (membership) => membership.sourceListingId,
              ),
            );
            job.acquisition = undefined;
            state.status.phase = "publishing";
            state.status.pending = job.publication.work.length;
          }
        } else if (job.publication) {
          const publication = job.publication;
          if (publication.retainUntil && publication.retainUntil < Date.now()) {
            rememberPublication(state);
            job.paused = true;
            job.publication = undefined;
            state.status.phase = "blocked";
            state.status.error = "SHIPPING_RETRY_RETENTION_REACHED";
            await this.save(state);
            if (state.reconcileAt)
              await this.ctx.storage.setAlarm(state.reconcileAt);
            return;
          }
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
          const removalCounts = new Map<string, number>();
          for (const work of publication.work) {
            if (
              work.resource.kind === "removeMembership" &&
              work.done &&
              !work.failed
            ) {
              const id = work.resource.sourceListingId;
              removalCounts.set(id, (removalCounts.get(id) ?? 0) + 1);
            }
          }
          const removed = new Set(
            [...removalCounts]
              .filter(([, count]) => count === 2)
              .map(([id]) => id),
          );
          state.memberships = [
            ...new Set([
              ...(state.memberships ?? []).filter((id) => !removed.has(id)),
              ...publication.work.flatMap((work) =>
                work.done && !work.failed && work.resource.kind === "membership"
                  ? [work.resource.value.sourceListingId]
                  : [],
              ),
            ]),
          ];
          if (state.memberships.length > SHIPPING_LIMITS.products * 2)
            throw new ShippingReadError("ACQUISITION_LIMIT_EXCEEDED");
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
          if (
            !remaining.length &&
            !publication.reconcile &&
            !job.refreshRequested
          ) {
            state.status.phase =
              publication.failures || state.status.limitations.length
                ? "partial"
                : "applied";
            state.job = undefined;
            state.reconcileAt = Date.now() + RECONCILIATION_INTERVAL;
            state.status.nextReconciliationAt = new Date(
              state.reconcileAt,
            ).toISOString();
            if (!publication.failures) state.status.error = undefined;
          } else if (
            remaining.length &&
            (!publication.reconcile || remaining.some((work) => work.pending))
          ) {
            const ready = readyPublicationWork(publication);
            const earliest = Math.min(...ready.map((work) => work.dueAt));
            if (!ready.length) {
              // Keep immutable requests and independent failed records for a
              // manual resume. Do not keep waking the object indefinitely.
              job.paused = true;
              state.status.phase = "blocked";
              state.status.error = "SHIPPING_RETRY_LIMIT_REACHED";
            } else if (earliest > Date.now()) {
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
        if (code === "SHIPPING_PERMISSION_REQUIRED") {
          // Withdrawing owned shipping components leaves catalog sync and
          // manual shipping/collection assertions independent.
          await this.startCleanup(state, job.shop, credentials, false, false);
          state.status.phase = "blocked";
        } else if (
          code === "SHOPIFY_CHANGED_DURING_READ" &&
          ++job.attempts <= 3
        ) {
          job.acquisition = beginAcquisition(new Date().toISOString());
          job.runId = crypto.randomUUID();
          job.sequence = nextSequence(state);
          job.failures = 0;
        } else if (
          code === "SHOPIFY_READ_FAILED" ||
          code === "SHIPPING_REQUEST_FAILED"
        ) {
          job.failures = (job.failures ?? 0) + 1;
          if (job.failures >= SHIPPING_LIMITS.retries) {
            job.paused = true;
            state.status.phase = "blocked";
            state.status.error = "SHIPPING_RETRY_LIMIT_REACHED";
          } else {
            state.status.phase = "partial";
            delay = Math.min(3600_000, 1000 * 2 ** job.failures);
          }
        } else {
          state.status.phase = "blocked";
          job.paused = true;
        }
      }
      await this.save(state);
      if (state.cleanup) await this.schedule(state, Date.now() + 1000);
      else if (state.job && !state.job.paused)
        await this.schedule(state, Date.now() + delay);
      else if (state.reconcileAt) await this.schedule(state, state.reconcileAt);
      else await this.ctx.storage.deleteAlarm();
    });
  }
}
