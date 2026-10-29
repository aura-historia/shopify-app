import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import type { AppLoadContext } from "react-router";
import type { GraphqlRequestFn } from "../app/backfill.server";
import { buildAuraHistoriaOAuthAuthorizeUrl } from "../app/oauth.server";
import { mapShipping } from "../app/shipping/mapper";
import {
  MARKET_SHIPPING_OBJECT_KEY,
  SHIPPING_LIMITS,
} from "../app/shipping/model";
import {
  beginPublication,
  type Publication,
  publishShippingStep,
} from "../app/shipping/publisher.server";
import { shippingIssueMessage } from "../app/shipping/status";
import { receiveShippingWebhook } from "../app/shipping/webhooks.server";
import {
  getShopCredentialsStorageKey,
  loadShopCredentials,
  markShopCredentialsDisconnected,
} from "../app/shop-credentials.server";
import type { CloudflareShopifyEnv } from "../app/shopify.server";
import {
  boundChannel,
  channelResponse,
  isChannelQuery,
} from "./helpers/channel-fixtures";
import {
  fixture,
  fixtureGraphql,
  importIdentityRejection,
  marketFixture,
  marketGraphql,
  missingListingProblem,
} from "./helpers/shipping-fixtures";

// Run the actual coordinator against isolated storage and the platform base
// class shim. No live Shopify installation, Cloudflare binding or Aura source.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: `data:text/javascript,${encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }")}`,
        shortCircuit: true,
      };
    // The OAuth callback's CSS module is not used by its loader.
    if (specifier.endsWith(".module.css"))
      return {
        url: "data:text/javascript,export default {}",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { ShopCoordinator, RECONCILIATION_INTERVAL } = await import(
  "../workers/shop-coordinator"
);
const { loader: oauthCallback } = await import("../app/routes/oauth.callback");
const home = await import("../app/routes/app._index");
const { getShopifyForEnv } = await import("../app/shopify.server");
const { Session } = await import("@shopify/shopify-api");
const { setAbstractFetchFunc } = await import("@shopify/shopify-api/runtime");
const shop = "shipping-fixture.myshopify.com";
const credentials = {
  listingSourceId: "ls_01h455vb4pex5vy7enb1p677v1",
  accessToken: "aura-private-token",
  updatedAt: "2026-10-18T08:00:00Z",
};
const nextSource = "ls_01h455vb4pex5vy7enb1p677v2";
type HomeData = Exclude<Awaited<ReturnType<typeof home.loader>>, Response>;
const contract = JSON.parse(
  readFileSync(
    new URL("./fixtures/shipping-contract.json", import.meta.url),
    "utf8",
  ),
);
const auraContext = {
  ...credentials,
  apiBaseUrl: "https://aura.invalid",
};

class MemoryStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined>;
  async get<T>(key: string[]): Promise<Map<string, T>>;
  async get<T>(key: string | string[]) {
    if (Array.isArray(key))
      return new Map(
        key.map((k) => [k, structuredClone(this.values.get(k)) as T]),
      );
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values))
      this.values.set(key, structuredClone(value));
  }
  async delete(keys: string[]) {
    for (const key of keys) this.values.delete(key);
  }
  async deleteAll() {
    this.values.clear();
  }
  async setAlarm(time: number) {
    this.alarm = time;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
  async transaction<T>(callback: (storage: MemoryStorage) => Promise<T>) {
    return callback(this);
  }
}

function isolatedRuntime() {
  const storage = new MemoryStorage();
  const kv = new Map<string, string>();
  kv.set(`aura-historia:shop-credentials:${shop}`, JSON.stringify(credentials));
  const env = {
    KV: {
      get: async (key: string, type?: string) => {
        const value = kv.get(key);
        return value ? (type === "json" ? JSON.parse(value) : value) : null;
      },
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
      delete: async (key: string) => {
        kv.delete(key);
      },
    },
    AURA_HISTORIA_API_BASE_URL: "https://aura.invalid",
    SHOPIFY_API_KEY: "test-shipping-runtime",
    SHOPIFY_API_SECRET: "private-shopify-secret",
    SHOPIFY_APP_URL: "https://app.invalid",
    SCOPES: "read_products,read_locales,read_shipping",
  } as CloudflareShopifyEnv;
  return {
    storage,
    kv,
    env,
    create<T>(
      coordinatorClass: new (
        ctx: DurableObjectState,
        env: CloudflareShopifyEnv,
      ) => T,
    ): T {
      return Reflect.construct(coordinatorClass, [{ storage }, env]);
    },
  };
}

function refreshRuntime() {
  const snapshot = structuredClone(fixture);
  delete snapshot.profiles["gid://shopify/DeliveryProfile/2"];
  delete snapshot.products["gid://shopify/Product/102"];
  const profile = snapshot.profiles["gid://shopify/DeliveryProfile/1"];
  delete profile.memberships["gid://shopify/Product/102"];
  profile.groups[0].zones = profile.groups[0].zones.slice(0, 1);
  profile.groups[0].zones[0].methods = profile.groups[0].zones[0].methods.slice(
    0,
    1,
  );
  profile.groups[0].zones[0].methods[0].rateProvider.price = {
    amount: "80.00",
    currencyCode: "EUR",
  };
  return coordinatorRuntime(fixtureGraphql(snapshot));
}

// Runs the actual coordinator against an isolated Shopify read model.
function coordinatorRuntime<
  Provider extends {
    request: GraphqlRequestFn;
    calls: { name: string; variables: Record<string, unknown> }[];
  },
>(provider: Provider) {
  const runtime = isolatedRuntime();
  const controls = {
    denied: false,
    unavailable: false,
    beforeRead: async () => {},
    afterRead: async () => {},
  };
  // The installation's granted scopes for catalog reads and the catalog
  // exports started through this coordinator.
  const catalog = { scopes: [] as string[], exports: 0 };
  class FixtureCoordinator extends ShopCoordinator {
    protected override async providerGraphql(
      _shop: string,
      query: string,
      variables: Record<string, unknown> = {},
    ) {
      // Connection setup reads shop metadata and channel access through the
      // same coordinator. Without channel access no bulk export starts.
      if (query.includes("shopLocales"))
        return {
          data: {
            shopLocales: [{ locale: "en", primary: true }],
            shop: { currencyCode: "EUR" },
          },
        };
      if (isChannelQuery(query))
        return channelResponse(
          query,
          {
            scopes: catalog.scopes,
            channel: boundChannel({ accountId: credentials.listingSourceId }),
          },
          variables,
        );
      if (query.includes("bulkOperationRunQuery"))
        return {
          data: {
            bulkOperationRunQuery: {
              bulkOperation: {
                id: `gid://shopify/BulkOperation/${++catalog.exports}`,
                status: "CREATED",
              },
              userErrors: [],
            },
          },
        };
      await controls.beforeRead();
      if (controls.denied)
        return { errors: [{ extensions: { code: "ACCESS_DENIED" } }] };
      if (controls.unavailable) throw new Error("unavailable provider");
      const body = structuredClone(await provider.request(query, variables));
      await controls.afterRead();
      return body;
    }
  }
  let coordinator = runtime.create(FixtureCoordinator);
  runtime.env.SHOP_COORDINATOR = {
    getByName: (name: string) => {
      assert.equal(name, shop);
      return coordinator;
    },
  } as unknown as CloudflareShopifyEnv["SHOP_COORDINATOR"];
  const context = {
    cloudflare: {
      env: runtime.env,
      ctx: {
        waitUntil() {
          throw new Error("detached work");
        },
      },
    },
  } as AppLoadContext;
  return {
    ...runtime,
    provider,
    controls,
    catalog,
    context,
    get coordinator() {
      return coordinator;
    },
    evict() {
      coordinator = runtime.create(FixtureCoordinator);
    },
    async installed() {
      await getShopifyForEnv(runtime.env).sessionStorage.storeSession(
        new Session({
          id: `offline_${shop}`,
          shop,
          state: "fixture",
          isOnline: false,
          accessToken: "private-shopify-token",
          scope: "read_products,read_locales,read_shipping",
        }),
      );
    },
    async run() {
      for (let i = 0; i < 200; i++) {
        await coordinator.alarm();
        const state = await storedState(runtime.storage);
        if (!state.job && !state.cleanup) return;
        assert.notEqual(state.job?.paused, true, JSON.stringify(state.status));
      }
      assert.fail("bounded job failed to finish");
    },
  };
}

async function storedState(storage: MemoryStorage) {
  const count = (await storage.get<number>("chunks")) ?? 0;
  let json = "";
  for (let i = 0; i < count; i++)
    json += await storage.get<string>(`state:${i}`);
  return json ? JSON.parse(json) : {};
}

function shippingCallback(
  topic = "profiles/update",
  id = crypto.randomUUID(),
  body: Record<string, unknown> = {
    id: 1,
    admin_graphql_api_id: "gid://shopify/DeliveryProfile/1",
    name: "Metadata only",
    version: 1,
  },
) {
  const raw = JSON.stringify(body);
  return new Request("https://app.invalid/webhooks/shipping", {
    method: "POST",
    body: raw,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": id,
      "X-Shopify-Hmac-Sha256": createHmac("sha256", "private-shopify-secret")
        .update(raw)
        .digest("base64"),
    },
  });
}

function backendFixture() {
  const calls: {
    method: string;
    path: string;
    body: Record<string, unknown> | null;
  }[] = [];
  let profile: typeof contract.committedProfile | undefined;
  const controls = {
    offline: false,
    manualSelection: false,
    missingListing: false,
  };
  const fetcher: typeof fetch = async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    const raw = await request.text();
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: request.method, path, body });
    if (controls.offline) return new Response(null, { status: 503 });
    const rejected = importIdentityRejection(request.method, path, body);
    if (rejected) return rejected;
    if (path.endsWith("shipping-profiles") && request.method === "GET")
      return Response.json(profile ? [profile] : []);
    if (path.includes("shipping-profiles")) {
      if (request.method !== "GET")
        profile = {
          ...contract.committedProfile,
          managementRevision: (profile?.managementRevision ?? 0) + 1,
          lifecycle: request.method === "DELETE" ? "RETIRED" : "ACTIVE",
          ...(body?.content ? { content: body.content } : {}),
        };
      return Response.json(profile, {
        status: request.method === "POST" ? 201 : 200,
      });
    }
    if (path.endsWith("shipping-default"))
      return Response.json({ revision: 1, shippingProfileId: null });
    if (path.endsWith("delivery")) {
      if (controls.missingListing) return missingListingProblem();
      if (request.method === "GET")
        return Response.json({
          expectedVersion: 1,
          productListingId: "pl_fixture",
          delivery: null,
        });
      if (
        controls.manualSelection &&
        body.delivery.value.selection.state !== "UNCHANGED"
      )
        return Response.json(
          { error: "SHIPPING_IMPORT_OWNERSHIP_CONFLICT" },
          { status: 409 },
        );
      return Response.json(contract.committedMembership);
    }
    assert.fail(`Unexpected shipping API call ${request.method} ${path}`);
  };
  return {
    fetcher,
    calls,
    controls,
    get profile() {
      return profile;
    },
  };
}

async function seedPublication(
  runtime: ReturnType<typeof isolatedRuntime>,
  publication: Publication,
) {
  await runtime.storage.put({
    chunks: 1,
    "state:0": JSON.stringify({
      sequence: publication.sequence,
      source: credentials.listingSourceId,
      mappings: publication.mappings,
      job: {
        shop,
        listingSourceId: credentials.listingSourceId,
        credentialVersion: credentials.updatedAt,
        sequence: publication.sequence,
        runId: publication.runId,
        publication,
        refreshRequested: false,
        attempts: 0,
      },
      status: {
        phase: "publishing",
        committed: 0,
        pending: publication.work.length,
        protected: 0,
        failures: 0,
        limitations: [],
      },
    }),
  });
}

// Product 102 has no profile dependency; only its catalog listing is awaited.
async function seedMissingListing(
  runtime: ReturnType<typeof isolatedRuntime>,
  attempts = 0,
) {
  const publication = beginPublication(
    mapShipping(fixture),
    "missing-listing",
    1,
    fixture.acquiredAt,
    {},
  );
  publication.work = publication.work.filter(
    (work) => work.key === "listing:102",
  );
  publication.work[0].attempts = attempts;
  await seedPublication(runtime, publication);
}

describe("server-side shipping coordinator", () => {
  it("resolves another uncertain write before reacquiring after a revision conflict", async () => {
    const runtime = isolatedRuntime();
    const publication = beginPublication(
      mapShipping(fixture),
      "lost-and-conflict",
      1,
      fixture.acquiredAt,
      {},
    );
    const prepare: typeof fetch = async () => Response.json([]);
    await publishShippingStep(publication, auraContext, 0, prepare);
    const original = structuredClone(publication.work[0].pending);
    assert.ok(original);
    await publishShippingStep(publication, auraContext, 0, async () => {
      throw new Error("lost response");
    });
    await publishShippingStep(publication, auraContext, 1, prepare);
    await seedPublication(runtime, publication);

    const provider = fixtureGraphql();
    class FixtureCoordinator extends ShopCoordinator {
      protected override providerGraphql(
        _shop: string,
        query: string,
        variables: Record<string, unknown> = {},
      ) {
        return provider.request(query, variables);
      }
    }
    let coordinator = runtime.create(FixtureCoordinator);
    const originalFetch = globalThis.fetch;
    const sent: unknown[] = [];
    try {
      globalThis.fetch = async (input) => {
        sent.push(await (input as Request).json());
        return Response.json(
          { error: "SHIPPING_IMPORT_AUTHORITY_STALE" },
          { status: 409 },
        );
      };
      // Keep the uncertain first request delayed while the second conflicts.
      publication.work[0].dueAt = Date.now() + 60_000;
      await seedPublication(runtime, publication);
      await coordinator.alarm();
      assert.equal(provider.calls.length, 0);
      assert.equal(sent.length, 1);
      // Eviction must retain both the conflict and the first exact request.
      coordinator = runtime.create(FixtureCoordinator);
      const realNow = Date.now;
      Date.now = () => realNow() + 120_000;
      try {
        globalThis.fetch = async (input) => {
          sent.push(await (input as Request).json());
          return Response.json(contract.committedProfile, { status: 201 });
        };
        await coordinator.alarm();
        assert.deepEqual(sent[1], original.body);
        assert.equal(provider.calls.length, 0);
        await coordinator.alarm();
        assert.equal(provider.calls[0].name, "ShippingPreflight");
      } finally {
        Date.now = realNow;
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("pauses exhausted publication and manually resumes the exact persisted request", async () => {
    const runtime = isolatedRuntime();
    const publication = beginPublication(
      mapShipping(fixture),
      "paused",
      1,
      fixture.acquiredAt,
      {},
    );
    publication.work = publication.work.slice(0, 1);
    await publishShippingStep(publication, auraContext, 0, async () =>
      Response.json([]),
    );
    const original = structuredClone(publication.work[0].pending);
    assert.ok(original);
    publication.work[0].attempts = SHIPPING_LIMITS.retries - 1;
    await seedPublication(runtime, publication);
    let coordinator = runtime.create(ShopCoordinator);
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        Response.json({ error: "temporary" }, { status: 503 });
      await coordinator.alarm();
      assert.equal((await coordinator.status()).phase, "blocked");
      assert.equal(
        (await coordinator.status()).error,
        "SHIPPING_RETRY_LIMIT_REACHED",
      );
      assert.equal(runtime.storage.alarm, null);
      coordinator = runtime.create(ShopCoordinator);
      let sent: unknown;
      globalThis.fetch = async (input) => {
        sent = await (input as Request).json();
        return Response.json(contract.committedProfile, { status: 201 });
      };
      await coordinator.requestShipping(shop);
      await coordinator.alarm();
      assert.deepEqual(sent, original.body);
      assert.equal((await coordinator.status()).committed, 1);
      assert.ok(Number.isFinite(runtime.storage.alarm));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports a missing catalog listing as a retried dependency and assigns it once listed", async () => {
    const runtime = isolatedRuntime();
    await seedMissingListing(runtime);
    const backend = backendFixture();
    backend.controls.missingListing = true;
    const coordinator = runtime.create(ShopCoordinator);
    const original = globalThis.fetch;
    const realNow = Date.now;
    globalThis.fetch = backend.fetcher;
    try {
      await coordinator.alarm();
      const waiting = await coordinator.status();
      assert.equal(waiting.phase, "partial");
      assert.equal(waiting.error, "SHIPPING_IMPORT_DEPENDENCY_MISSING");
      assert.match(
        shippingIssueMessage(waiting.error ?? ""),
        /catalog listings are not available yet.*retried automatically/,
      );
      assert.equal(waiting.pending, 1);
      assert.equal(waiting.failures, 0);
      assert.ok((runtime.storage.alarm ?? 0) > Date.now());
      assert.doesNotMatch(
        JSON.stringify(await storedState(runtime.storage)),
        /PRODUCT_LISTING_NOT_FOUND/,
      );

      backend.controls.missingListing = false;
      Date.now = () => realNow() + 60_000;
      await coordinator.alarm();
      await coordinator.alarm();
      const applied = await coordinator.status();
      assert.equal(applied.phase, "applied");
      assert.equal(applied.error, undefined);
      assert.equal(applied.committed, 1);
      assert.equal(applied.pending, 0);
      const assignments = backend.calls.filter(
        (call) => call.method === "PATCH",
      );
      assert.equal(assignments.length, 1);
      const body = assignments[0].body as { import: { requestKey: string } };
      assert.equal(body.import.requestKey, "missing-listing:listing:102");
      // Shipping work only waits for the catalog; it never creates listings.
      assert.ok(
        backend.calls.every((call) =>
          call.path.endsWith(
            `/listing-sources/${credentials.listingSourceId}/product-listings/by-source-id/102/delivery`,
          ),
        ),
      );
    } finally {
      globalThis.fetch = original;
      Date.now = realNow;
    }
  });

  it("pauses a still-missing catalog listing at the retry limit", async () => {
    const runtime = isolatedRuntime();
    await seedMissingListing(runtime, SHIPPING_LIMITS.retries - 1);
    const backend = backendFixture();
    backend.controls.missingListing = true;
    const coordinator = runtime.create(ShopCoordinator);
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    try {
      await coordinator.alarm();
      const status = await coordinator.status();
      assert.equal(status.phase, "blocked");
      assert.equal(status.error, "SHIPPING_RETRY_LIMIT_REACHED");
      assert.equal(status.pending, 1);
      const { job } = await storedState(runtime.storage);
      assert.equal(job.paused, true);
      assert.equal(
        job.publication.lastError,
        "SHIPPING_IMPORT_DEPENDENCY_MISSING",
      );
      assert.equal(job.publication.work[0].exhausted, true);
      assert.equal(job.publication.work[0].done, undefined);
      assert.equal(runtime.storage.alarm, null);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("bounds consecutive acquisition failures and allows a new manual acquisition", async () => {
    const runtime = isolatedRuntime();
    const provider = fixtureGraphql();
    let failing = true;
    class FixtureCoordinator extends ShopCoordinator {
      protected override providerGraphql(
        _shop: string,
        query: string,
        variables: Record<string, unknown> = {},
      ) {
        if (failing) throw new Error("provider unavailable");
        return provider.request(query, variables);
      }
    }
    const coordinator = runtime.create(FixtureCoordinator);
    await coordinator.requestShipping(shop);
    for (let i = 0; i < SHIPPING_LIMITS.retries; i++) await coordinator.alarm();
    assert.equal(
      (await coordinator.status()).error,
      "SHIPPING_RETRY_LIMIT_REACHED",
    );
    assert.ok(
      (runtime.storage.alarm ?? 0) >=
        Date.now() + RECONCILIATION_INTERVAL - 1000,
    );
    failing = false;
    await coordinator.requestShipping(shop);
    await coordinator.alarm();
    assert.equal((await coordinator.status()).phase, "acquiring");
    assert.equal((await coordinator.status()).error, undefined);
  });

  it("supersedes an older acquisition through the same ordered refresh entry point", async () => {
    const runtime = isolatedRuntime();
    const provider = fixtureGraphql();
    class FixtureCoordinator extends ShopCoordinator {
      protected override providerGraphql(
        _shop: string,
        query: string,
        variables: Record<string, unknown> = {},
      ) {
        return provider.request(query, variables);
      }
    }
    const coordinator = runtime.create(FixtureCoordinator);
    await coordinator.requestShipping(shop);
    await coordinator.alarm();
    await coordinator.requestShipping(shop);
    await coordinator.alarm();
    assert.deepEqual(
      provider.calls.map((call) => call.name),
      ["ShippingPreflight", "ShippingPreflight"],
    );
    assert.equal((await coordinator.status()).committed, 0);
    await coordinator.cancel(true);
  });

  it("stops a queued job when its protected connection record changes", async () => {
    const runtime = isolatedRuntime();
    const coordinator = runtime.create(ShopCoordinator);
    await coordinator.requestShipping(shop);
    runtime.kv.delete(`aura-historia:shop-credentials:${shop}`);
    await coordinator.alarm();
    assert.equal(
      (await coordinator.status()).error,
      "CONNECTION_CHANGED_REACQUIRE",
    );
    assert.ok(
      (runtime.storage.alarm ?? 0) >= Date.now() + 7 * 86_400_000 - 1000,
    );
  });

  it("starts a fresh acquisition when reconnecting while old work is queued", async () => {
    const runtime = isolatedRuntime();
    const provider = fixtureGraphql();
    class FixtureCoordinator extends ShopCoordinator {
      protected override providerGraphql(
        _shop: string,
        query: string,
        variables: Record<string, unknown> = {},
      ) {
        return provider.request(query, variables);
      }
    }
    const coordinator = runtime.create(FixtureCoordinator);
    await coordinator.requestShipping(shop);
    await coordinator.alarm();
    runtime.kv.set(
      `aura-historia:shop-credentials:${shop}`,
      JSON.stringify({ ...credentials, updatedAt: "2026-10-18T09:00:00Z" }),
    );
    await coordinator.requestShipping(shop);
    await coordinator.alarm();
    assert.deepEqual(
      provider.calls.map((call) => call.name),
      ["ShippingPreflight", "ShippingPreflight"],
    );
    assert.equal((await coordinator.status()).phase, "acquiring");
    assert.equal((await coordinator.status()).error, undefined);
  });

  it("handles API version headers and scope denials through the actual Shopify SDK", async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const outcome of ["success", "version", "denied"] as const) {
        const runtime = isolatedRuntime();
        await getShopifyForEnv(runtime.env).sessionStorage.storeSession(
          new Session({
            id: `offline_${shop}`,
            shop,
            state: "fixture",
            isOnline: false,
            accessToken: "private-shopify-token",
            scope: "read_products,read_locales,read_shipping",
          }),
        );
        const provider = fixtureGraphql();
        globalThis.fetch = async () =>
          Response.json(
            outcome === "denied"
              ? {
                  errors: [
                    {
                      message: "Access denied",
                      extensions: { code: "ACCESS_DENIED" },
                    },
                  ],
                }
              : await provider.request(
                  "query ShippingPreflight { shop { id } }",
                  {},
                ),
            {
              headers: {
                "X-Shopify-API-Version":
                  outcome === "version" ? "2027-01" : "2026-10",
              },
            },
          );
        setAbstractFetchFunc(globalThis.fetch);
        const coordinator = runtime.create(ShopCoordinator);
        await coordinator.requestShipping(shop);
        await coordinator.alarm();
        const status = await coordinator.status();
        assert.equal(
          status.phase,
          outcome === "success" ? "acquiring" : "blocked",
        );
        assert.equal(
          status.error,
          outcome === "success"
            ? undefined
            : outcome === "denied"
              ? "SHIPPING_PERMISSION_REQUIRED"
              : "UNSUPPORTED_SHOPIFY_API_VERSION",
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
      setAbstractFetchFunc(originalFetch);
    }
  });

  it("reports missing offline access without retrying indefinitely", async () => {
    const runtime = isolatedRuntime();
    const coordinator = runtime.create(ShopCoordinator);
    await coordinator.requestShipping(shop);
    await coordinator.alarm();
    assert.equal(
      (await coordinator.status()).error,
      "SHOPIFY_OFFLINE_ACCESS_REQUIRED",
    );
    assert.equal((await coordinator.status()).phase, "blocked");
    assert.ok(
      (runtime.storage.alarm ?? 0) >=
        Date.now() + RECONCILIATION_INTERVAL - 1000,
    );
  });

  it("continues acquisition after eviction without a browser and erases state on uninstall", async () => {
    const runtime = isolatedRuntime();
    const provider = fixtureGraphql();
    class FixtureCoordinator extends ShopCoordinator {
      protected override providerGraphql(
        _shop: string,
        query: string,
        variables: Record<string, unknown> = {},
      ) {
        return provider.request(query, variables);
      }
    }
    let coordinator = runtime.create(FixtureCoordinator);
    assert.equal(await coordinator.requestShipping(shop), true);
    assert.equal((await coordinator.status()).phase, "queued");
    await coordinator.alarm();
    coordinator = runtime.create(FixtureCoordinator);
    for (
      let step = 0;
      (await coordinator.status()).phase !== "publishing";
      step++
    ) {
      assert.ok(step < 100);
      await coordinator.alarm();
      // Stop before external Aura publication. Preparing a typed request is a
      // separate persisted step from sending it.
      if (
        provider.calls.length > 35 &&
        JSON.stringify([...runtime.storage.values.values()]).includes(
          '"publication"',
        )
      )
        break;
    }
    assert.ok(provider.calls.some((call) => call.name === "ShippingVariants"));
    assert.doesNotMatch(
      JSON.stringify([...runtime.storage.values.values()]),
      /aura-private-token|private-shopify-secret|refresh-private/,
    );
    await coordinator.cancel(true);
    assert.equal(runtime.storage.values.size, 0);
    assert.equal(runtime.storage.alarm, null);
  });

  it("uses the SDK refresh once for concurrent catalog and shipping requests", async () => {
    const runtime = isolatedRuntime();
    const session = new Session({
      id: `offline_${shop}`,
      shop,
      state: "fixture",
      isOnline: false,
      accessToken: "old-private-token",
      scope: "read_products,read_locales,read_shipping",
      expires: new Date(Date.now() - 1000),
      refreshToken: "refresh-private",
      refreshTokenExpires: new Date(Date.now() + 86_400_000),
    });
    await getShopifyForEnv(runtime.env).sessionStorage.storeSession(session);
    const originalFetch = globalThis.fetch;
    let refreshes = 0;
    const usedTokens: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("/oauth/access_token")) {
        refreshes++;
        return Response.json({
          access_token: "new-private-token",
          refresh_token: "rotated-private",
          expires_in: 3600,
          refresh_token_expires_in: 86_400,
          scope: "read_products,read_locales,read_shipping",
        });
      }
      usedTokens.push(request.headers.get("X-Shopify-Access-Token") ?? "");
      return Response.json({ data: { shop: { id: "gid://shopify/Shop/1" } } });
    };
    setAbstractFetchFunc(globalThis.fetch);
    try {
      const coordinator = runtime.create(ShopCoordinator);
      await Promise.all([
        coordinator.graphql(shop, "query Catalog { shop { id } }", {}),
        coordinator.graphql(shop, "query Shipping { shop { id } }", {}),
      ]);
      assert.equal(refreshes, 1);
      assert.deepEqual(usedTokens, ["new-private-token", "new-private-token"]);
      assert.equal(runtime.storage.values.size, 0);
    } finally {
      globalThis.fetch = originalFetch;
      setAbstractFetchFunc(originalFetch);
    }
  });
});

describe("S02 authenticated shipping refresh and recovery", () => {
  it("queues metadata-only callbacks durably and applies EUR 80 -> 95 through S01", async () => {
    const runtime = refreshRuntime();
    await runtime.installed();
    const backend = backendFixture();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      assert.match(JSON.stringify(backend.profile), /"amount_minor":8000/);
      runtime.provider.snapshot.profiles[
        "gid://shopify/DeliveryProfile/1"
      ].groups[0].zones[0].methods[0].rateProvider.price = {
        amount: "95.00",
        currencyCode: "EUR",
      };
      const before = runtime.provider.calls.length;
      const response = await receiveShippingWebhook(
        shippingCallback(),
        runtime.context,
      );
      assert.equal(response.status, 200);
      assert.equal(runtime.provider.calls.length, before);
      assert.ok(runtime.storage.values.get("hintVersion"));
      runtime.evict();
      await runtime.run();
      assert.match(JSON.stringify(backend.profile), /"amount_minor":9500/);
      const assignments = backend.calls.filter(
        (call) => call.path.endsWith("delivery") && call.body,
      );
      assert.ok(assignments.length >= 2);
      for (const assignment of assignments) {
        const body = assignment.body as {
          delivery: { value: { shipping: unknown; collection: unknown } };
          import: { observation: unknown };
        };
        assert.deepEqual(body.delivery.value.shipping, { state: "UNCHANGED" });
        assert.deepEqual(body.delivery.value.collection, {
          state: "UNCHANGED",
        });
        assert.deepEqual(body.import.observation, {});
      }
      assert.ok(
        backend.calls.every((call) =>
          call.path.includes(credentials.listingSourceId),
        ),
      );
      assert.doesNotMatch(
        JSON.stringify(backend.calls),
        /private-shopify-token|freshUntil|expiresAt/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refreshes the created profile on an unchanged re-import without its creation-only key", async () => {
    const runtime = refreshRuntime();
    await runtime.installed();
    const backend = backendFixture();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      const { status } = await storedState(runtime.storage);
      assert.equal(status.failures, 0);
      assert.equal(status.error, undefined);
      assert.ok(status.committed > 0);
      assert.equal(backend.profile?.managementRevision, 2);
      const profileWrite = (method: string) => {
        const writes = backend.calls.filter(
          (call) =>
            call.method === method && call.path.includes("shipping-profiles"),
        );
        assert.equal(writes.length, 1);
        return writes[0].body as {
          import: Record<string, unknown>;
          expectedRevision?: number;
        };
      };
      const created = profileWrite("POST").import;
      const replaced = profileWrite("PUT");
      assert.equal(created.objectKey, "shopify:delivery-profile:1");
      assert.equal(replaced.expectedRevision, 1);
      assert.equal("objectKey" in replaced.import, false);
      assert.deepEqual(replaced.import.observation, {});
      assert.equal(replaced.import.acquiredAt, status.acquiredAt);
      assert.ok(Number(replaced.import.sequence) > Number(created.sequence));
      assert.notEqual(replaced.import.requestKey, created.requestKey);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects bad signatures, wrong topics/profiles and oversized original bodies", async () => {
    const runtime = refreshRuntime();
    await runtime.installed();
    await runtime.coordinator.requestShipping(shop);
    const bad = shippingCallback();
    bad.headers.set("X-Shopify-Hmac-Sha256", "invalid");
    await assert.rejects(
      () => receiveShippingWebhook(bad, runtime.context),
      (error: unknown) => error instanceof Response && error.status === 401,
    );
    for (const request of [
      shippingCallback("products/update"),
      shippingCallback("profiles/update", crypto.randomUUID(), {
        id: 1,
        admin_graphql_api_id: "gid://shopify/Product/1",
      }),
      shippingCallback("profiles/update", crypto.randomUUID(), {
        id: 2,
        admin_graphql_api_id: "gid://shopify/DeliveryProfile/1",
      }),
    ])
      assert.equal(
        (await receiveShippingWebhook(request, runtime.context)).status,
        400,
      );
    await assert.rejects(
      () =>
        receiveShippingWebhook(
          shippingCallback("profiles/update", crypto.randomUUID(), {
            data: "x".repeat(17_000),
          }),
          runtime.context,
        ),
      (error: unknown) => error instanceof Response && error.status === 413,
    );
    assert.equal(runtime.storage.values.get("hintVersion"), undefined);
    assert.equal(runtime.provider.calls.length, 0);
  });

  it("does not bind unknown installations, trust a supplied Aura source, or revive a disconnected binding", async () => {
    const runtime = refreshRuntime();
    assert.equal(
      (await receiveShippingWebhook(shippingCallback(), runtime.context))
        .status,
      200,
    );
    await runtime.installed();
    assert.equal(
      (await receiveShippingWebhook(shippingCallback(), runtime.context))
        .status,
      200,
    );
    assert.equal(runtime.storage.values.get("hintVersion"), undefined);
    await runtime.coordinator.requestShipping(shop);
    await receiveShippingWebhook(
      shippingCallback("profiles/update", crypto.randomUUID(), {
        id: 1,
        admin_graphql_api_id: "gid://shopify/DeliveryProfile/1",
        listingSourceId: "attacker-source",
      }),
      runtime.context,
    );
    assert.equal(
      (await storedState(runtime.storage)).binding.listingSourceId,
      credentials.listingSourceId,
    );
    await runtime.coordinator.disconnectShipping(shop, true);
    const before = runtime.storage.values.get("hintVersion");
    await receiveShippingWebhook(shippingCallback(), runtime.context);
    assert.equal(runtime.storage.values.get("hintVersion"), before);
    assert.equal(await runtime.coordinator.requestShipping(shop), false);
    assert.equal((await storedState(runtime.storage)).job, undefined);
  });

  it("deduplicates within a connection and returns 503 when durable admission fails", async () => {
    const runtime = refreshRuntime();
    await runtime.installed();
    await runtime.coordinator.requestShipping(shop);
    const id = crypto.randomUUID();
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await receiveShippingWebhook(
            shippingCallback("profiles/update", id),
            runtime.context,
          )
        ).status,
        200,
      );
    assert.equal(runtime.storage.values.get("hintVersion"), 1);
    const put = runtime.storage.put.bind(runtime.storage);
    runtime.storage.put = async (values) => {
      if ("hintVersion" in values) throw new Error("storage unavailable");
      await put(values);
    };
    assert.equal(
      (await receiveShippingWebhook(shippingCallback(), runtime.context))
        .status,
      503,
    );
    runtime.storage.put = put;
    assert.equal(runtime.storage.values.get("hintVersion"), 1);
    await runtime.coordinator.saveConnection(shop, credentials);
    assert.equal(
      (
        await receiveShippingWebhook(
          shippingCallback("profiles/update", id),
          runtime.context,
        )
      ).status,
      200,
    );
    assert.equal(runtime.storage.values.get("hintVersion"), 2);
  });

  it("authenticates expiring offline sessions without refreshing in the callback", async () => {
    const runtime = refreshRuntime();
    await getShopifyForEnv(runtime.env).sessionStorage.storeSession(
      new Session({
        id: `offline_${shop}`,
        shop,
        state: "fixture",
        isOnline: false,
        accessToken: "expired-private-token",
        refreshToken: "private-refresh-token",
        expires: new Date(Date.now() - 1000),
        refreshTokenExpires: new Date(Date.now() + 86_400_000),
      }),
    );
    await runtime.coordinator.requestShipping(shop);
    const original = globalThis.fetch;
    let externalCalls = 0;
    globalThis.fetch = async () => {
      externalCalls++;
      throw new Error("callback must not call providers");
    };
    setAbstractFetchFunc(globalThis.fetch);
    try {
      assert.equal(
        (await receiveShippingWebhook(shippingCallback(), runtime.context))
          .status,
        200,
      );
      assert.equal(externalCalls, 0);
      assert.equal(runtime.provider.calls.length, 0);
    } finally {
      globalThis.fetch = original;
      setAbstractFetchFunc(original);
    }
  });

  it("reports revoked offline refresh tokens as reauthorization without manufacturing absence", async () => {
    const runtime = isolatedRuntime();
    await getShopifyForEnv(runtime.env).sessionStorage.storeSession(
      new Session({
        id: `offline_${shop}`,
        shop,
        state: "fixture",
        isOnline: false,
        accessToken: "expired-private-token",
        refreshToken: "private-refresh-token",
        expires: new Date(Date.now() - 1000),
        refreshTokenExpires: new Date(Date.now() + 86_400_000),
      }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({ error: "invalid_subject_token" }, { status: 400 });
    setAbstractFetchFunc(globalThis.fetch);
    try {
      const coordinator = runtime.create(ShopCoordinator);
      await coordinator.requestShipping(shop);
      await coordinator.alarm();
      assert.equal(
        (await coordinator.status()).error,
        "SHOPIFY_OFFLINE_ACCESS_REQUIRED",
      );
      assert.equal((await coordinator.status()).committed, 0);
      assert.equal((await storedState(runtime.storage)).cleanup, undefined);
    } finally {
      globalThis.fetch = original;
      setAbstractFetchFunc(original);
    }
  });

  it("admits a callback during an in-flight EUR 80 read and discards that older acquisition", async () => {
    const runtime = refreshRuntime();
    await runtime.installed();
    await runtime.coordinator.requestShipping(shop);
    for (
      let i = 0;
      (await storedState(runtime.storage)).job.acquisition.tasks[0].kind !==
      "methods";
      i++
    ) {
      assert.ok(i < 30);
      await runtime.coordinator.alarm();
    }
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    runtime.controls.afterRead = async () => {
      entered();
      await held;
    };
    const older = runtime.coordinator.alarm();
    await started;
    // This must finish while the worker's provider read is still held.
    assert.equal(
      (await receiveShippingWebhook(shippingCallback(), runtime.context))
        .status,
      200,
    );
    runtime.provider.snapshot.profiles[
      "gid://shopify/DeliveryProfile/1"
    ].groups[0].zones[0].methods[0].rateProvider.price = {
      amount: "95.00",
      currencyCode: "EUR",
    };
    runtime.controls.afterRead = async () => {};
    release();
    await older;
    assert.match(
      JSON.stringify((await storedState(runtime.storage)).job.acquisition),
      /"amount":"80.00"/,
    );
    await runtime.coordinator.requestShipping(shop); // simultaneous manual repair coalesces
    const backend = backendFixture();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    try {
      runtime.evict();
      await runtime.run();
      assert.match(JSON.stringify(backend.profile), /"amount_minor":9500/);
      assert.doesNotMatch(JSON.stringify(backend.calls), /"amount_minor":8000/);
      assert.equal(
        runtime.provider.calls.filter(
          (call) => call.name === "ShippingPreflight",
        ).length,
        2,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("converges delayed create/update/delete on current state and removes only confirmed profiles", async () => {
    const runtime = refreshRuntime();
    await runtime.installed();
    const backend = backendFixture();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      for (const topic of [
        "profiles/delete",
        "profiles/create",
        "profiles/update",
      ])
        await receiveShippingWebhook(shippingCallback(topic), runtime.context);
      await runtime.run();
      assert.equal(
        backend.calls.filter(
          (call) =>
            call.method === "DELETE" && call.path.includes("shipping-profiles"),
        ).length,
        0,
      );
      delete runtime.provider.snapshot.profiles[
        "gid://shopify/DeliveryProfile/1"
      ];
      await receiveShippingWebhook(
        shippingCallback("profiles/delete"),
        runtime.context,
      );
      runtime.controls.unavailable = true;
      await runtime.coordinator.alarm();
      assert.equal(
        backend.calls.filter(
          (call) =>
            call.method === "DELETE" && call.path.includes("shipping-profiles"),
        ).length,
        0,
      );
      runtime.controls.unavailable = false;
      await runtime.run();
      assert.equal(backend.profile.lifecycle, "RETIRED");
      const lastAssignment = backend.calls
        .filter((call) => call.path.endsWith("delivery") && call.body)
        .at(-1);
      assert.match(
        JSON.stringify(lastAssignment?.body),
        /SUPPRESS_INHERITANCE/,
      );
      assert.doesNotMatch(
        JSON.stringify(lastAssignment?.body),
        /"kind":"INHERIT_SOURCE_DEFAULT"/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("repairs membership and rates without any notification using bounded periodic reads", async () => {
    const runtime = refreshRuntime();
    const backend = backendFixture();
    const original = globalThis.fetch;
    const realNow = Date.now;
    globalThis.fetch = backend.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      runtime.provider.snapshot.profiles[
        "gid://shopify/DeliveryProfile/1"
      ].memberships = {};
      const before = backend.calls.length;
      Date.now = () => realNow() + RECONCILIATION_INTERVAL + 1000;
      await runtime.run();
      const writes = backend.calls.slice(before).filter((call) => call.body);
      assert.ok(writes.length);
      assert.match(JSON.stringify(writes), /SUPPRESS_INHERITANCE/);
      assert.ok(
        writes.every((call) =>
          /shipping-profiles|shipping-default|\/delivery$/.test(call.path),
        ),
      );
      assert.ok((runtime.storage.alarm ?? 0) > Date.now());
      assert.ok(runtime.provider.calls.length < 100);
    } finally {
      globalThis.fetch = original;
      Date.now = realNow;
    }
  });

  it("withdraws only owned components on permission loss while catalog access stays available", async () => {
    const runtime = refreshRuntime();
    await runtime.installed();
    const backend = backendFixture();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      backend.controls.manualSelection = true;
      runtime.controls.denied = true;
      await receiveShippingWebhook(
        shippingCallback("app/scopes_update", crypto.randomUUID(), {
          current: ["read_products"],
          previous: ["read_products", "read_shipping"],
        }),
        runtime.context,
      );
      await runtime.run();
      const status = await runtime.coordinator.status();
      assert.equal(status.cleanup, "committed");
      assert.equal(status.tokenRevoked, false);
      assert.equal(backend.profile.lifecycle, "RETIRED");
      const removals = backend.calls.filter(
        (call) =>
          call.path.endsWith("delivery") &&
          call.body &&
          JSON.stringify(call.body).includes('"state":"CLEAR"'),
      );
      assert.equal(removals.length, 2);
      for (const call of removals) {
        assert.doesNotMatch(JSON.stringify(call.body), /"observation"/);
        assert.match(
          JSON.stringify(call.body),
          /"collection":\{"state":"UNCHANGED"\}/,
        );
      }
      assert.ok(runtime.kv.has(`aura-historia:shop-credentials:${shop}`));
      assert.ok(
        await getShopifyForEnv(runtime.env).sessionStorage.loadSession(
          `offline_${shop}`,
        ),
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("imports shipping once an existing installation approves the required scope", async () => {
    const runtime = refreshRuntime();
    await runtime.installed();
    const backend = backendFixture();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    try {
      runtime.controls.denied = true;
      assert.equal(await runtime.coordinator.requestShipping(shop), true);
      await runtime.run();
      let status = await runtime.coordinator.status();
      assert.equal(status.phase, "blocked");
      assert.equal(status.error, "SHIPPING_PERMISSION_REQUIRED");
      assert.equal(
        backend.calls.some(
          (call) =>
            call.path.includes("shipping-profiles") && call.method !== "GET",
        ),
        false,
      );
      runtime.controls.denied = false;
      const response = await receiveShippingWebhook(
        shippingCallback("app/scopes_update", crypto.randomUUID(), {
          current: ["read_products", "read_locales", "read_shipping"],
          previous: ["read_products", "read_locales"],
        }),
        runtime.context,
      );
      assert.equal(response.status, 200);
      await runtime.run();
      status = await runtime.coordinator.status();
      assert.equal(status.error, undefined);
      assert.ok(status.committed > 0);
      assert.equal(backend.profile?.lifecycle, "ACTIVE");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("records unreachable uninstall cleanup separately, retains terms beyond 30 days, and reacquires on reconnect", async () => {
    const runtime = refreshRuntime();
    const backend = backendFixture();
    const original = globalThis.fetch;
    const realNow = Date.now;
    globalThis.fetch = backend.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      await runtime.coordinator.disconnectShipping(shop, true);
      runtime.kv.delete(`aura-historia:shop-credentials:${shop}`);
      backend.controls.offline = true;
      Date.now = () => realNow() + 8 * 86_400_000;
      await runtime.coordinator.alarm();
      const status = await runtime.coordinator.status();
      assert.equal(status.cleanup, "unconfirmed");
      assert.equal(status.tokenRevoked, false);
      assert.equal((await storedState(runtime.storage)).job, undefined);
      Date.now = () => realNow() + 31 * 86_400_000;
      await runtime.coordinator.alarm();
      assert.equal(runtime.storage.values.size, 0);
      // Observation age and local erasure cannot modify backend assertions.
      assert.equal(backend.profile.lifecycle, "ACTIVE");
      assert.match(JSON.stringify(backend.profile), /"amount_minor":8000/);
      backend.controls.offline = false;
      Date.now = realNow;
      runtime.provider.snapshot.profiles[
        "gid://shopify/DeliveryProfile/1"
      ].groups[0].zones[0].methods[0].rateProvider.price = {
        amount: "95.00",
        currencyCode: "EUR",
      };
      await runtime.coordinator.saveConnection(shop, credentials);
      await runtime.run();
      assert.match(JSON.stringify(backend.profile), /"amount_minor":9500/);
      assert.doesNotMatch(
        JSON.stringify([...runtime.storage.values]),
        /aura-private-token|private-shopify-token/,
      );
    } finally {
      globalThis.fetch = original;
      Date.now = realNow;
    }
  });
});

describe("S02 connection lifecycle", () => {
  it("does not let manual import restore credentials marked disconnected after local state erasure", async () => {
    const runtime = refreshRuntime();
    await markShopCredentialsDisconnected(runtime.env.KV, shop);
    // The protected connection can still be visible while its deletion propagates.
    assert.equal(await runtime.coordinator.requestShipping(shop), false);
    assert.equal(runtime.storage.values.size, 0);
    assert.equal(runtime.storage.alarm, null);
    await runtime.coordinator.saveConnection(shop, credentials);
    assert.equal(await runtime.coordinator.requestShipping(shop), true);
    assert.ok((await storedState(runtime.storage)).job.acquisition);
  });

  it("withdraws the old source before publishing a freshly acquired source switch", async () => {
    const runtime = refreshRuntime();
    await runtime.installed();
    const backend = backendFixture();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      // An older scan is in progress when OAuth selects another source.
      await runtime.coordinator.requestShipping(shop);
      await runtime.coordinator.alarm();
      await runtime.coordinator.saveConnection(shop, {
        ...credentials,
        listingSourceId: nextSource,
        accessToken: "new-aura-token",
      });
      assert.equal(
        (await storedState(runtime.storage)).job.listingSourceId,
        nextSource,
      );
      runtime.provider.snapshot.profiles[
        "gid://shopify/DeliveryProfile/1"
      ].groups[0].zones[0].methods[0].rateProvider.price = {
        amount: "95.00",
        currencyCode: "EUR",
      };
      const offset = backend.calls.length;
      runtime.evict();
      await runtime.run();
      const writes = backend.calls.slice(offset).filter((call) => call.body);
      const firstNew = writes.findIndex((call) =>
        call.path.includes(nextSource),
      );
      assert.ok(firstNew > 0);
      assert.ok(
        writes
          .slice(0, firstNew)
          .every((call) => call.path.includes(credentials.listingSourceId)),
      );
      assert.ok(
        writes.slice(firstNew).every((call) => call.path.includes(nextSource)),
      );
      assert.match(
        JSON.stringify(writes.slice(firstNew)),
        /"amount_minor":9500/,
      );
      assert.doesNotMatch(
        JSON.stringify(writes.slice(firstNew)),
        /"amount_minor":8000/,
      );
      assert.equal((await runtime.coordinator.status()).cleanup, "committed");
      const sourceScope = await storedState(runtime.storage);
      assert.equal(sourceScope.binding.listingSourceId, nextSource);
      assert.doesNotMatch(
        JSON.stringify(sourceScope),
        /new-aura-token|aura-private-token/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("records explicit removals and OAuth revocation separately after uninstall", async () => {
    const runtime = refreshRuntime();
    const backend = backendFixture();
    runtime.env.AURA_HISTORIA_OAUTH_CLIENT_ID = "oc_01h455vb4pex5vy7enb1p677v1";
    runtime.env.AURA_HISTORIA_OAUTH_CLIENT_SECRET = "private-oauth-secret";
    const original = globalThis.fetch;
    let revocations = 0;
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("/oauth/revoke")) {
        revocations++;
        assert.ok(String(init?.body).includes("aura-private-token"));
        return new Response(null, { status: 204 });
      }
      return backend.fetcher(input, init);
    };
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      await runtime.coordinator.disconnectShipping(shop, true);
      runtime.kv.delete(`aura-historia:shop-credentials:${shop}`);
      await runtime.run();
      const status = await runtime.coordinator.status();
      assert.equal(status.cleanup, "committed");
      assert.equal(status.tokenRevoked, true);
      assert.equal(revocations, 1);
      assert.equal(backend.profile.lifecycle, "RETIRED");
      assert.ok(
        [...runtime.kv.keys()].every(
          (key) => !key.includes("shipping-cleanup"),
        ),
      );
      const stop = await storedState(runtime.storage);
      assert.deepEqual(stop.mappings, {});
      assert.equal(stop.cleanup, undefined);
      assert.equal(stop.job, undefined);
      await runtime.coordinator.disconnectShipping(shop, true);
      assert.equal((await runtime.coordinator.status()).cleanup, "committed");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("S02 scope fencing", () => {
  it("fences an immutable prepared write after an observed scope change before replay", async () => {
    const runtime = refreshRuntime();
    await runtime.installed();
    const backend = backendFixture();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      for (
        let i = 0;
        (await runtime.coordinator.status()).phase !== "publishing";
        i++
      ) {
        assert.ok(i < 50);
        await runtime.coordinator.alarm();
      }
      await runtime.coordinator.alarm();
      assert.equal(
        (await storedState(runtime.storage)).job.publication.work[0].pending
          .kind,
        "create",
      );
      runtime.controls.denied = true;
      await receiveShippingWebhook(
        shippingCallback("app/scopes_update", crypto.randomUUID(), {
          current: ["read_products"],
        }),
        runtime.context,
      );
      await runtime.run();
      assert.equal(
        backend.calls.filter((call) => call.method === "POST").length,
        0,
      );
      assert.equal(
        (await runtime.coordinator.status()).error,
        "SHIPPING_PERMISSION_REQUIRED",
      );
      assert.equal((await runtime.coordinator.status()).cleanup, "committed");
      assert.equal((await storedState(runtime.storage)).job, undefined);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// Drives the actual OAuth callback and embedded home against the coordinator.
function connectionRuntime() {
  const runtime = refreshRuntime();
  runtime.env.AURA_HISTORIA_OAUTH_CLIENT_ID = "oc_01h455vb4pex5vy7enb1p677v1";
  runtime.env.AURA_HISTORIA_OAUTH_CLIENT_SECRET = "private-oauth-secret";
  getShopifyForEnv(runtime.env).authenticate.admin = (async () => ({
    session: { shop, scope: "read_products" },
    redirect: (url: string) =>
      new Response(null, { status: 302, headers: { Location: url } }),
  })) as never;
  const backend = backendFixture();
  const controls = { conflict: "" };
  const revoked: string[] = [];
  const configured: string[] = [];
  const exchanged = new Set<string>();
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const path = new URL(request.url).pathname;
    if (path === "/v1/oauth/token") {
      const code = new URLSearchParams(await request.text()).get("code") ?? "";
      // Authorization codes are single use.
      if (exchanged.has(code))
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      exchanged.add(code);
      return Response.json({ access_token: `aura-token-${code}` });
    }
    if (path === "/v1/oauth/revoke") {
      revoked.push(
        new URLSearchParams(await request.text()).get("token") ?? "",
      );
      return new Response(null, { status: 200 });
    }
    if (path.endsWith("/ingestion-configurations/shopify")) {
      configured.push(path);
      // The live backend rejects a shop domain bound to another source.
      return new Response(null, {
        status:
          controls.conflict && path.includes(controls.conflict) ? 409 : 204,
      });
    }
    return backend.fetcher(request);
  };
  const call = (request: Request) =>
    ({ request, context: runtime.context, params: {} }) as never;
  return {
    ...runtime,
    backend,
    controls,
    revoked,
    configured,
    fetcher,
    // Starts an authorization now; the returned callback can run later.
    async authorize(code: string, source = credentials.listingSourceId) {
      const started = await buildAuraHistoriaOAuthAuthorizeUrl(
        runtime.env.KV,
        runtime.env,
        shop,
      );
      assert.ok(started.isReady);
      const url = new URL("https://app.invalid/oauth/callback");
      url.searchParams.set("code", code);
      url.searchParams.set("state", started.state);
      url.searchParams.set("listing_source_id", source);
      return async () => {
        const response = await oauthCallback(call(new Request(url)));
        assert.ok(response instanceof Response);
        return new URL(response.headers.get("Location") ?? "").searchParams;
      };
    },
    async home(query = "") {
      return home.loader(call(new Request(`https://app.invalid/app?${query}`)));
    },
    async act(intent: string) {
      const body = new FormData();
      body.set("intent", intent);
      const response = await home.action(
        call(new Request("https://app.invalid/app", { method: "POST", body })),
      );
      return new URL(
        response.headers.get("Location") ?? "",
        "https://app.invalid",
      ).searchParams;
    },
    cleanups(state: { cleanup?: unknown; cleanupQueue?: unknown[] }) {
      return [state.cleanup, ...(state.cleanupQueue ?? [])].filter(Boolean) as {
        credentialVersion: string;
        credentialKey: string;
        revoke: boolean;
      }[];
    },
  };
}

describe("OAuth connection replacement", () => {
  it("keeps the current connection running when the new grant's configuration fails", async () => {
    const runtime = connectionRuntime();
    const original = globalThis.fetch;
    globalThis.fetch = runtime.fetcher;
    try {
      assert.equal(await runtime.coordinator.requestShipping(shop), true);
      await runtime.coordinator.alarm();
      const before = await storedState(runtime.storage);
      runtime.controls.conflict = credentials.listingSourceId;
      const callback = await runtime.authorize("second");
      assert.equal((await callback()).get("oauth"), "failed");
      // Only the unused new grant is revoked; the current record and its
      // binding, work and absent cleanup obligation are unchanged.
      assert.deepEqual(runtime.revoked, ["aura-token-second"]);
      assert.deepEqual(
        await loadShopCredentials(runtime.env.KV, shop),
        credentials,
      );
      const after = await storedState(runtime.storage);
      assert.equal(after.stopped, false);
      assert.deepEqual(after.binding, before.binding);
      assert.deepEqual(after.job, before.job);
      assert.deepEqual(runtime.cleanups(after), []);
      assert.ok(
        [...runtime.kv.keys()].every(
          (key) => !key.includes("shipping-cleanup"),
        ),
      );
      const data = (await runtime.home("oauth=failed")) as HomeData;
      assert.equal(data.integration.status, "connected");
      assert.equal(data.integration.replacementFailed, true);
      assert.equal(
        data.credentials?.listingSourceId,
        credentials.listingSourceId,
      );
      assert.equal(
        (await runtime.act("import_shipping")).get("shipping"),
        null,
      );
      runtime.controls.conflict = "";
      await runtime.run();
      const status = await runtime.coordinator.status();
      assert.equal(status.error, undefined);
      assert.ok(status.committed > 0);
      assert.deepEqual(runtime.revoked, ["aura-token-second"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("leaves the current binding untouched when the new record cannot be stored", async () => {
    const runtime = connectionRuntime();
    const original = globalThis.fetch;
    globalThis.fetch = runtime.fetcher;
    const set = runtime.kv.set.bind(runtime.kv);
    runtime.kv.set = (key, value) => {
      if (key === getShopCredentialsStorageKey(shop))
        throw new Error("KV write failed");
      return set(key, value);
    };
    try {
      assert.equal(await runtime.coordinator.requestShipping(shop), true);
      const before = await storedState(runtime.storage);
      assert.equal(
        (await (await runtime.authorize("second"))()).get("oauth"),
        "failed",
      );
      assert.deepEqual(runtime.revoked, ["aura-token-second"]);
      assert.deepEqual(await storedState(runtime.storage), before);
      // The previous token's cleanup copy is dropped with the attempt.
      assert.ok(
        [...runtime.kv.keys()].every(
          (key) => !key.includes("shipping-cleanup"),
        ),
      );
      assert.equal(
        await runtime.coordinator.connectionRetired(credentials.updatedAt),
        false,
      );
      assert.equal(await runtime.coordinator.requestShipping(shop), true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("binds a same-source replacement and revokes the previous grant after its cleanup", async () => {
    const runtime = connectionRuntime();
    const original = globalThis.fetch;
    globalThis.fetch = runtime.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      const params = await (await runtime.authorize("second"))();
      assert.equal(params.get("oauth"), "connected");
      // A backfill failure after persistence keeps the new connection.
      assert.equal(params.get("backfill"), "not_queued");
      const stored = await loadShopCredentials(runtime.env.KV, shop);
      assert.equal(stored?.accessToken, "aura-token-second");
      const state = await storedState(runtime.storage);
      assert.equal(state.stopped, false);
      assert.equal(state.binding.credentialVersion, stored?.connectionId);
      assert.ok(state.job.acquisition);
      const [cleanup, ...rest] = runtime.cleanups(state);
      assert.deepEqual(rest, []);
      assert.equal(cleanup.credentialVersion, credentials.updatedAt);
      assert.equal(cleanup.revoke, true);
      assert.equal(
        JSON.parse(runtime.kv.get(cleanup.credentialKey) ?? "{}").accessToken,
        credentials.accessToken,
      );
      assert.deepEqual(runtime.revoked, []);
      const data = (await runtime.home("oauth=connected")) as HomeData;
      assert.equal(data.integration.status, "connected");
      assert.equal(data.integration.replacementFailed, false);
      assert.equal(await runtime.coordinator.requestShipping(shop), true);
      await runtime.run();
      const status = await runtime.coordinator.status();
      assert.equal(status.error, undefined);
      assert.ok(status.committed > 0);
      assert.equal(status.cleanup, "committed");
      assert.equal(status.tokenRevoked, true);
      assert.deepEqual(runtime.revoked, [credentials.accessToken]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("orders overlapping callbacks so every replaced grant is cleaned up", async () => {
    for (const conflict of ["", nextSource]) {
      const runtime = connectionRuntime();
      const original = globalThis.fetch;
      globalThis.fetch = runtime.fetcher;
      runtime.controls.conflict = conflict;
      try {
        await runtime.coordinator.requestShipping(shop);
        await runtime.coordinator.alarm();
        const first = await runtime.authorize("first");
        const second = await runtime.authorize("second", nextSource);
        const results = await Promise.all([first(), second()]);
        assert.deepEqual(
          results.map((params) => params.get("oauth")),
          ["connected", conflict ? "failed" : "connected"],
        );
        const stored = await loadShopCredentials(runtime.env.KV, shop);
        const state = await storedState(runtime.storage);
        assert.equal(state.stopped, false);
        assert.equal(state.binding.credentialVersion, stored?.connectionId);
        assert.equal(state.binding.listingSourceId, stored?.listingSourceId);
        const superseded = runtime.cleanups(state).map((cleanup) => {
          assert.equal(cleanup.revoke, true);
          return JSON.parse(runtime.kv.get(cleanup.credentialKey) ?? "{}")
            .accessToken;
        });
        // Each grant is current, queued for cleanup, or revoked as unused.
        assert.deepEqual(
          [stored?.accessToken, ...superseded, ...runtime.revoked].sort(),
          [credentials.accessToken, "aura-token-first", "aura-token-second"],
        );
        assert.deepEqual(
          runtime.revoked,
          conflict ? ["aura-token-second"] : [],
        );
        assert.equal(await runtime.coordinator.requestShipping(shop), true);
        await runtime.run();
        assert.deepEqual(
          [...runtime.revoked].sort(),
          [credentials.accessToken, "aura-token-first", "aura-token-second"]
            .filter((token) => token !== stored?.accessToken)
            .sort(),
        );
        assert.equal(
          ((await runtime.home()) as HomeData).integration.status,
          "connected",
        );
      } finally {
        globalThis.fetch = original;
      }
    }
  });

  it("connects a double-submitted callback once and leaves that connection on replay", async () => {
    const runtime = connectionRuntime();
    const original = globalThis.fetch;
    globalThis.fetch = runtime.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      const callback = await runtime.authorize("second");
      const results = await Promise.all([callback(), callback()]);
      assert.deepEqual(results.map((params) => params.get("oauth")).sort(), [
        "connected",
        "failed",
      ]);
      const state = await storedState(runtime.storage);
      assert.equal(
        (await loadShopCredentials(runtime.env.KV, shop))?.accessToken,
        "aura-token-second",
      );
      assert.equal(runtime.cleanups(state).length, 1);
      assert.equal((await callback()).get("oauth"), "failed");
      assert.deepEqual(await storedState(runtime.storage), state);
      // A rejected code issued no grant, so nothing new is revoked.
      assert.deepEqual(runtime.revoked, []);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("withdraws and revokes a replaced record that was never bound", async () => {
    const runtime = connectionRuntime();
    const original = globalThis.fetch;
    globalThis.fetch = runtime.fetcher;
    try {
      assert.equal(
        (await (await runtime.authorize("second"))()).get("oauth"),
        "connected",
      );
      const [cleanup, ...rest] = runtime.cleanups(
        await storedState(runtime.storage),
      );
      assert.deepEqual(rest, []);
      assert.equal(cleanup.credentialVersion, credentials.updatedAt);
      assert.equal(cleanup.revoke, true);
      await runtime.run();
      assert.deepEqual(runtime.revoked, [credentials.accessToken]);
      assert.equal((await runtime.coordinator.status()).tokenRevoked, true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports a stopped stored record as stopped and recovers only through a new authorization", async () => {
    const runtime = connectionRuntime();
    const original = globalThis.fetch;
    const realNow = Date.now;
    globalThis.fetch = runtime.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      // The binding was stopped and its revocation queued, but the record
      // stayed stored, e.g. a disconnect whose deletion failed.
      await runtime.coordinator.disconnectShipping(shop);
      assert.ok(await loadShopCredentials(runtime.env.KV, shop));
      let data = (await runtime.home()) as HomeData;
      assert.equal(data.integration.status, "stopped");
      assert.equal(data.credentials, null);
      assert.equal(
        (await runtime.act("import_shipping")).get("shipping"),
        "not_queued",
      );
      assert.equal(
        (await runtime.act("retry_backfill")).get("backfill"),
        "not_queued",
      );
      assert.deepEqual(runtime.configured, []);
      await runtime.run();
      assert.deepEqual(runtime.revoked, [credentials.accessToken]);
      assert.notDeepEqual((await storedState(runtime.storage)).mappings, {});
      // The fence outlives local retention while the record is stored, but
      // only as a minimal tombstone.
      Date.now = () => realNow() + 8 * 86_400_000;
      await runtime.coordinator.alarm();
      Date.now = realNow;
      const tombstone = await storedState(runtime.storage);
      assert.deepEqual(tombstone.mappings, {});
      assert.equal(tombstone.memberships, undefined);
      assert.equal(tombstone.stopped, true);
      assert.equal(runtime.storage.alarm, null);
      assert.equal(
        await runtime.coordinator.connectionRetired(credentials.updatedAt),
        true,
      );
      assert.equal(await runtime.coordinator.requestShipping(shop), false);
      const reconnect = await runtime.home("manual_connect=1");
      assert.ok(reconnect instanceof Response);
      assert.match(
        reconnect.headers.get("Location") ?? "",
        /^https:\/\/stage\.aura-historia\.com\/en\/oauth\/authorize\?/,
      );
      assert.equal(
        (await (await runtime.authorize("fresh"))()).get("oauth"),
        "connected",
      );
      data = (await runtime.home()) as HomeData;
      assert.equal(data.integration.status, "connected");
      assert.equal(await runtime.coordinator.requestShipping(shop), true);
      await runtime.run();
      assert.equal((await runtime.coordinator.status()).error, undefined);
      // The already revoked record is not cleaned up or revoked twice.
      assert.deepEqual(runtime.revoked, [credentials.accessToken]);
    } finally {
      globalThis.fetch = original;
      Date.now = realNow;
    }
  });
});

// Stores every profile under its creation key, so model switches can be
// observed per identity.
function keyedBackend() {
  type StoredProfile = typeof contract.committedProfile;
  const profiles = new Map<string, { key: string; body: StoredProfile }>();
  const calls: {
    method: string;
    path: string;
    body: Record<string, unknown> | null;
  }[] = [];
  let defaultId: string | null = null;
  const fetcher: typeof fetch = async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const path = url.pathname;
    const raw = await request.text();
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: request.method, path, body });
    const rejected = importIdentityRejection(request.method, path, body);
    if (rejected) return rejected;
    if (path.endsWith("/shipping-profiles")) {
      if (request.method === "GET")
        return Response.json(
          [...profiles.values()]
            .filter(({ key }) => key === url.searchParams.get("objectKey"))
            .map(({ body }) => body),
        );
      const created = {
        ...contract.committedProfile,
        shippingProfileId: `shp_${profiles.size + 1}`,
        content: body.content,
      };
      profiles.set(created.shippingProfileId, {
        key: body.import.objectKey,
        body: created,
      });
      return Response.json(created, { status: 201 });
    }
    const profile = /shipping-profiles\/([^/]+)/.exec(path);
    if (profile) {
      const stored = profiles.get(profile[1]);
      assert.ok(stored);
      if (request.method !== "GET")
        stored.body = {
          ...stored.body,
          managementRevision: stored.body.managementRevision + 1,
          lifecycle: request.method === "DELETE" ? "RETIRED" : "ACTIVE",
          ...(body?.content ? { content: body.content } : {}),
        };
      return Response.json(stored.body);
    }
    if (path.endsWith("shipping-default")) {
      if (request.method !== "GET") defaultId = body?.shippingProfileId ?? null;
      return Response.json({ revision: 1, shippingProfileId: defaultId });
    }
    if (path.endsWith("delivery"))
      return request.method === "GET"
        ? Response.json({
            expectedVersion: 1,
            productListingId: "pl_fixture",
            delivery: null,
          })
        : Response.json(contract.committedMembership);
    assert.fail(`Unexpected shipping API call ${request.method} ${path}`);
  };
  return {
    fetcher,
    calls,
    get defaultId() {
      return defaultId;
    },
    profile(key: string) {
      return [...profiles.values()].find((stored) => stored.key === key)?.body;
    },
  };
}

function marketCallback(
  topic: string,
  body: Record<string, unknown>,
  id = crypto.randomUUID(),
) {
  return shippingCallback(topic, id, body);
}

describe("market-driven shipping coordinator", () => {
  const option = (provider: ReturnType<typeof marketGraphql>, index: number) =>
    provider.markets[0].shipping?.optionDefinitions[index] as {
      freeDeliveryMinimumValue: { amount: string };
      flatGroups: { nodes: { rate: { price: { amount: string } } }[] };
    };

  it("imports markets and follows rate, threshold, option and market removals without changing Shopify", async () => {
    const provider = marketGraphql();
    const runtime = coordinatorRuntime(provider);
    await runtime.installed();
    const backend = keyedBackend();
    const original = globalThis.fetch;
    const realNow = Date.now;
    globalThis.fetch = backend.fetcher;
    const terms = () =>
      JSON.stringify(backend.profile(MARKET_SHIPPING_OBJECT_KEY)?.content);
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      let status = await runtime.coordinator.status();
      assert.equal(status.error, undefined);
      assert.equal(status.failures, 0);
      assert.equal(status.phase, "partial");
      assert.ok(status.limitations.includes("APP_PROVIDED_RATES_UNASSERTED"));
      const profile = backend.profile(MARKET_SHIPPING_OBJECT_KEY);
      assert.equal(profile?.lifecycle, "ACTIVE");
      assert.equal(backend.defaultId, profile?.shippingProfileId);
      // Standard is free from EUR 50; its EUR 17.23 applies only below that.
      assert.doesNotMatch(terms(), /"amount_minor":1723/);
      assert.match(terms(), /"amount_minor":5000/);
      assert.match(terms(), /"amount_minor":2900/);
      assert.match(
        terms(),
        /"code":"US".*"code":"DE".*"code":"FR".*"code":"AT"/,
      );
      const assignments = backend.calls.filter(
        (call) => call.path.endsWith("delivery") && call.body,
      );
      assert.equal(assignments.length, 2);
      for (const assignment of assignments)
        assert.match(
          JSON.stringify(assignment.body),
          new RegExp(
            `"kind":"EXPLICIT","profile_id":"${profile?.shippingProfileId}"`,
          ),
        );

      // A rate and free threshold edit, notified through markets/update.
      option(provider, 1).flatGroups.nodes[0].rate.price.amount = "31.50";
      option(provider, 0).freeDeliveryMinimumValue.amount = "75.00";
      const before = provider.calls.length;
      const response = await receiveShippingWebhook(
        marketCallback("markets/update", {
          ...marketFixture.evidence.webhookPayload,
          id: 1,
        }),
        runtime.context,
      );
      assert.equal(response.status, 200);
      assert.equal(provider.calls.length, before);
      runtime.evict();
      await runtime.run();
      const unitedStates = JSON.parse(terms()).terms.shipping.coverage.zones[0];
      assert.deepEqual(
        unitedStates.services.map(
          (service: {
            code: string;
            applicability: { threshold: { minimum: unknown } | null };
            rate: { price: unknown } | null;
          }) => [
            service.code.split(":").slice(2).join(":"),
            service.applicability.threshold?.minimum ?? null,
            service.rate?.price ?? null,
          ],
        ),
        [
          ["11", null, null],
          [
            "11:free",
            { amount_minor: 7500, currency: "EUR" },
            { kind: "FREE", currency: "EUR" },
          ],
          [
            "12",
            null,
            { kind: "FIXED", amount: { amount_minor: 3150, currency: "EUR" } },
          ],
        ],
      );

      // Shopify documents no notification for option edits; the periodic
      // read removes the deleted Express option.
      provider.markets[0].shipping?.optionDefinitions.splice(1, 1);
      Date.now = () => realNow() + RECONCILIATION_INTERVAL + 1000;
      await runtime.run();
      assert.doesNotMatch(terms(), /DeliveryFlatRateOptionDefinition:12/);

      // Removing Europe leaves Germany without shipping and keeps Austria.
      provider.markets.splice(1, 1);
      await receiveShippingWebhook(
        marketCallback("markets/delete", { id: 2 }),
        runtime.context,
      );
      await runtime.run();
      assert.doesNotMatch(terms(), /"code":"DE"|"code":"FR"/);
      assert.match(terms(), /"code":"AT"/);
      status = await runtime.coordinator.status();
      assert.equal(status.error, undefined);
      assert.equal(status.failures, 0);
      // Only reads reached Shopify, so merchant markets stay untouched.
      assert.ok(
        provider.calls.every((call) => /^Shipping[A-Z]\w+$/.test(call.name)),
      );
      assert.equal(
        provider.calls.some((call) => call.name === "ShippingProfiles"),
        false,
      );
    } finally {
      globalThis.fetch = original;
      Date.now = realNow;
    }
  });

  // A shop that moves between Shopify's profile and market models.
  const switchingProvider = () => {
    const legacy = fixtureGraphql();
    const markets = marketGraphql();
    const provider = {
      mode: "profiles",
      calls: legacy.calls,
      markets,
      request: ((query, variables) =>
        (provider.mode === "markets" ? markets : legacy).request(
          query,
          variables,
        )) as GraphqlRequestFn,
    };
    return provider;
  };

  it("withdraws the other model's terms when a shop moves to market-driven shipping and back", async () => {
    const provider = switchingProvider();
    const runtime = coordinatorRuntime(provider);
    await runtime.installed();
    const backend = keyedBackend();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    const lifecycle = (key: string) => backend.profile(key)?.lifecycle;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      assert.equal(lifecycle("shopify:delivery-profile:1"), "ACTIVE");
      assert.equal(lifecycle("shopify:delivery-profile:2"), "ACTIVE");
      provider.mode = "markets";
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      assert.equal(lifecycle("shopify:delivery-profile:1"), "RETIRED");
      assert.equal(lifecycle("shopify:delivery-profile:2"), "RETIRED");
      assert.equal(lifecycle(MARKET_SHIPPING_OBJECT_KEY), "ACTIVE");
      assert.equal(
        backend.defaultId,
        backend.profile(MARKET_SHIPPING_OBJECT_KEY)?.shippingProfileId,
      );
      // A rollback to profiles restores those identities and retires markets.
      provider.mode = "profiles";
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      assert.equal(lifecycle("shopify:delivery-profile:1"), "ACTIVE");
      assert.equal(lifecycle(MARKET_SHIPPING_OBJECT_KEY), "RETIRED");
      assert.equal((await runtime.coordinator.status()).failures, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("withdraws stale profile terms while a market-driven import is blocked", async () => {
    const provider = switchingProvider();
    const runtime = coordinatorRuntime(provider);
    await runtime.installed();
    const backend = keyedBackend();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    const retired = () =>
      backend.calls.filter(
        (call) =>
          call.method === "DELETE" && call.path.includes("shipping-profiles/"),
      ).length;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      assert.ok(backend.defaultId);
      provider.mode = "markets";
      const regions = provider.markets.markets[0].regions;
      provider.markets.markets[0].regions = [
        { __typename: "MarketRegionFuture", id: "gid://shopify/Future/1" },
      ];
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      let status = await runtime.coordinator.status();
      assert.equal(status.phase, "blocked");
      assert.equal(status.error, "UNSUPPORTED_SHOPIFY_SCHEMA");
      assert.equal(status.cleanup, "committed");
      assert.equal(
        backend.profile("shopify:delivery-profile:1")?.lifecycle,
        "RETIRED",
      );
      assert.equal(
        backend.profile("shopify:delivery-profile:2")?.lifecycle,
        "RETIRED",
      );
      assert.equal(backend.defaultId, null);
      assert.equal(backend.profile(MARKET_SHIPPING_OBJECT_KEY), undefined);
      const cleared = backend.calls.filter(
        (call) =>
          call.path.endsWith("delivery") &&
          JSON.stringify(call.body).includes('"selection":{"state":"CLEAR"}'),
      );
      assert.equal(cleared.length, 2);
      assert.equal(retired(), 2);
      // A repaired configuration publishes Markets without a second retire.
      provider.markets.markets[0].regions = regions;
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      status = await runtime.coordinator.status();
      assert.equal(status.error, undefined);
      assert.equal(status.failures, 0);
      assert.equal(
        backend.profile(MARKET_SHIPPING_OBJECT_KEY)?.lifecycle,
        "ACTIVE",
      );
      assert.equal(
        backend.defaultId,
        backend.profile(MARKET_SHIPPING_OBJECT_KEY)?.shippingProfileId,
      );
      assert.equal(retired(), 2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports missing market access, imports once approved and retries unavailable reads", async () => {
    const provider = marketGraphql();
    provider.controls.scopes = ["read_shipping"];
    const runtime = coordinatorRuntime(provider);
    await runtime.installed();
    const backend = keyedBackend();
    const original = globalThis.fetch;
    globalThis.fetch = backend.fetcher;
    try {
      await runtime.coordinator.requestShipping(shop);
      await runtime.run();
      let status = await runtime.coordinator.status();
      assert.equal(status.phase, "blocked");
      assert.equal(status.error, "SHIPPING_PERMISSION_REQUIRED");
      assert.equal(backend.profile(MARKET_SHIPPING_OBJECT_KEY), undefined);
      provider.controls.scopes = ["read_shipping", "read_markets"];
      await receiveShippingWebhook(
        marketCallback("app/scopes_update", {
          current: ["read_shipping", "read_markets"],
          previous: ["read_shipping"],
        }),
        runtime.context,
      );
      await runtime.run();
      status = await runtime.coordinator.status();
      assert.equal(status.error, undefined);
      assert.equal(
        backend.profile(MARKET_SHIPPING_OBJECT_KEY)?.lifecycle,
        "ACTIVE",
      );
      runtime.controls.unavailable = true;
      await runtime.coordinator.requestShipping(shop);
      await runtime.coordinator.alarm();
      status = await runtime.coordinator.status();
      assert.equal(status.phase, "partial");
      assert.equal(status.error, "SHIPPING_REQUEST_FAILED");
      runtime.controls.unavailable = false;
      await runtime.run();
      status = await runtime.coordinator.status();
      assert.equal(status.error, undefined);
      assert.equal(status.failures, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("admits only well-formed market notifications for the bound installation", async () => {
    const runtime = coordinatorRuntime(marketGraphql());
    await runtime.installed();
    await runtime.coordinator.requestShipping(shop);
    for (const body of [
      {},
      { id: 0 },
      { id: "market" },
      { id: 2 ** 60 },
      { id: 1, admin_graphql_api_id: "gid://shopify/Market/2" },
      { id: 1, admin_graphql_api_id: "gid://shopify/DeliveryProfile/1" },
    ])
      assert.equal(
        (
          await receiveShippingWebhook(
            marketCallback("markets/update", body),
            runtime.context,
          )
        ).status,
        400,
        JSON.stringify(body),
      );
    assert.equal(runtime.storage.values.get("hintVersion"), undefined);
    const delivery = crypto.randomUUID();
    for (const topic of ["markets/create", "markets/update"])
      assert.equal(
        (
          await receiveShippingWebhook(
            marketCallback(
              topic,
              marketFixture.evidence.webhookPayload,
              delivery,
            ),
            runtime.context,
          )
        ).status,
        200,
      );
    // Deliveries are deduplicated per topic.
    await receiveShippingWebhook(
      marketCallback("markets/update", { id: "1" }, delivery),
      runtime.context,
    );
    assert.equal(runtime.storage.values.get("hintVersion"), 2);
    assert.equal((await runtime.coordinator.status()).phase, "queued");
  });
});

describe("catalog access approval", () => {
  it("asks for missing publication access and resumes the blocked import once approved", async () => {
    const runtime = connectionRuntime();
    const scopeUpdate = (current: string[]) =>
      receiveShippingWebhook(
        shippingCallback("app/scopes_update", crypto.randomUUID(), {
          current,
          previous: ["read_products"],
        }),
        runtime.context,
      );
    await runtime.installed();
    const original = globalThis.fetch;
    globalThis.fetch = runtime.fetcher;
    try {
      // The grants of an installation approved before `read_publications`
      // was required (#392).
      const before = [
        "read_locales",
        "read_markets",
        "read_product_listings",
        "read_products",
        "read_shipping",
      ];
      runtime.catalog.scopes = before;
      assert.equal(await runtime.coordinator.requestShipping(shop), true);
      await runtime.run();
      assert.equal(
        (await runtime.act("retry_backfill")).get("backfill"),
        "not_queued",
      );
      let data = (await runtime.home()) as HomeData;
      assert.deepEqual(data.publication, { state: "missing_scope" });
      assert.equal(data.catalogImport?.error, "MISSING_SCOPE");
      assert.equal(
        data.permissionsUrl,
        "https://admin.shopify.com/store/shipping-fixture/oauth/install?client_id=test-shipping-runtime",
      );
      // A scope notification without publication access changes nothing.
      assert.equal((await scopeUpdate(before)).status, 200);
      await runtime.run();
      assert.equal(runtime.catalog.exports, 0);

      runtime.catalog.scopes = [...before, "read_publications"];
      assert.equal((await scopeUpdate(runtime.catalog.scopes)).status, 200);
      await runtime.run();
      assert.equal(runtime.catalog.exports, 1);
      data = (await runtime.home()) as HomeData;
      assert.equal(data.publication?.state, "ready");
      assert.equal(data.permissionsUrl, null);
      assert.equal(data.catalogImport?.phase, "queued");
      assert.equal(data.catalogImport?.error, undefined);
      // Shipping keeps running, and a later notification never restarts the
      // admitted import.
      assert.equal((await runtime.coordinator.status()).error, undefined);
      await scopeUpdate(runtime.catalog.scopes);
      await runtime.run();
      assert.equal(runtime.catalog.exports, 1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
