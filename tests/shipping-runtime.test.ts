import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import type { CloudflareShopifyEnv } from "../app/shopify.server";
import { fixtureGraphql } from "./helpers/shipping-fixtures";

// Run the actual coordinator against isolated storage and the platform base
// class shim. No live Shopify installation, Cloudflare binding or Aura source.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: `data:text/javascript,${encodeURIComponent("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }")}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { ShopCoordinator } = await import("../workers/shop-coordinator");
const { getShopifyForEnv } = await import("../app/shopify.server");
const { Session } = await import("@shopify/shopify-api");
const { setAbstractFetchFunc } = await import("@shopify/shopify-api/runtime");
const shop = "shipping-fixture.myshopify.com";
const credentials = {
  listingSourceId: "ls_01h455vb4pex5vy7enb1p677v1",
  accessToken: "aura-private-token",
  updatedAt: "2026-10-18T08:00:00Z",
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
    SCOPES: "read_products,read_locales",
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

describe("server-side shipping coordinator", () => {
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
    assert.equal(runtime.storage.alarm, null);
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
    assert.equal(runtime.storage.alarm, null);
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
