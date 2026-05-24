import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, mock } from "node:test";
import {
  type BackfillContext,
  type BulkJsonlProduct,
  clearBackfillContext,
  extractShopifyNumericId,
  fetchShopMetadata,
  type GraphqlRequestFn,
  htmlToMarkdown,
  loadBackfillContext,
  mapShopifyStatus,
  parseProductsFromJsonl,
  resolveLanguage,
  storeBackfillContext,
  submitBulkOperation,
  transformProduct,
  triggerBackfill,
} from "../app/backfill.server";

function makeProduct(
  overrides: Partial<BulkJsonlProduct> = {},
): BulkJsonlProduct {
  return {
    id: "gid://shopify/Product/12345",
    title: "Antique Clock",
    descriptionHtml: "<p>A beautiful <strong>antique</strong> clock.</p>",
    status: "ACTIVE",
    totalInventory: 5,
    onlineStoreUrl: "https://my-shop.myshopify.com/products/antique-clock",
    ...overrides,
  };
}

function makeKv() {
  const entries = new Map<string, string>();
  return {
    get: mock.fn(async (key: string) => entries.get(key) ?? null),
    put: mock.fn(
      async (key: string, value: string, _opts?: { expirationTtl?: number }) =>
        entries.set(key, value),
    ),
    delete: mock.fn(async (key: string) => entries.delete(key)),
    _entries: entries,
  };
}

describe("extractShopifyNumericId", () => {
  it("extracts numeric ID from a Shopify GID", () => {
    assert.equal(
      extractShopifyNumericId("gid://shopify/Product/12345"),
      "12345",
    );
  });

  it("handles plain numeric strings", () => {
    assert.equal(extractShopifyNumericId("99999"), "99999");
  });
});

describe("mapShopifyStatus", () => {
  it("maps ACTIVE with inventory to AVAILABLE", () => {
    assert.equal(mapShopifyStatus("ACTIVE", 5), "AVAILABLE");
  });

  it("maps ACTIVE with null inventory (untracked) to AVAILABLE", () => {
    assert.equal(mapShopifyStatus("ACTIVE", null), "AVAILABLE");
  });

  it("maps ACTIVE with zero inventory to SOLD", () => {
    assert.equal(mapShopifyStatus("ACTIVE", 0), "SOLD");
  });

  it("maps ACTIVE with negative inventory to SOLD", () => {
    assert.equal(mapShopifyStatus("ACTIVE", -1), "SOLD");
  });

  it("maps DRAFT to LISTED regardless of inventory", () => {
    assert.equal(mapShopifyStatus("DRAFT", 10), "LISTED");
    assert.equal(mapShopifyStatus("DRAFT", 0), "LISTED");
  });

  it("maps ARCHIVED to REMOVED", () => {
    assert.equal(mapShopifyStatus("ARCHIVED", 0), "REMOVED");
  });

  it("maps unknown statuses to UNKNOWN", () => {
    assert.equal(mapShopifyStatus("SOMETHING_ELSE", null), "UNKNOWN");
  });
});

describe("resolveLanguage", () => {
  it("maps supported Shopify locales to LanguageData", () => {
    assert.equal(resolveLanguage("de"), "de");
    assert.equal(resolveLanguage("en"), "en");
    assert.equal(resolveLanguage("fr"), "fr");
    assert.equal(resolveLanguage("ja"), "ja");
  });

  it("extracts base locale from regional codes", () => {
    assert.equal(resolveLanguage("en-US"), "en");
    assert.equal(resolveLanguage("de-AT"), "de");
    assert.equal(resolveLanguage("pt-BR"), "pt");
  });

  it("falls back to English for unsupported locales", () => {
    assert.equal(resolveLanguage("ko"), "en");
    assert.equal(resolveLanguage("sv"), "en");
  });
});

describe("htmlToMarkdown", () => {
  it("converts paragraphs", () => {
    assert.equal(htmlToMarkdown("<p>Hello</p><p>World</p>"), "Hello\n\nWorld");
  });

  it("converts bold and italic", () => {
    assert.equal(
      htmlToMarkdown("<strong>bold</strong> and <em>italic</em>"),
      "**bold** and *italic*",
    );
  });

  it("converts headings", () => {
    assert.equal(htmlToMarkdown("<h1>Title</h1>"), "# Title");
    assert.equal(htmlToMarkdown("<h3>Subtitle</h3>"), "### Subtitle");
  });

  it("converts unordered lists", () => {
    const html = "<ul><li>Item A</li><li>Item B</li></ul>";
    assert.equal(htmlToMarkdown(html), "- Item A\n- Item B");
  });

  it("converts ordered lists", () => {
    const html = "<ol><li>First</li><li>Second</li></ol>";
    assert.equal(htmlToMarkdown(html), "1. First\n2. Second");
  });

  it("converts links", () => {
    assert.equal(
      htmlToMarkdown('<a href="https://example.com">click</a>'),
      "[click](https://example.com)",
    );
  });

  it("converts line breaks", () => {
    assert.equal(htmlToMarkdown("Line 1<br>Line 2"), "Line 1  \nLine 2");
  });

  it("strips unsupported tags", () => {
    assert.equal(htmlToMarkdown("<div><span>text</span></div>"), "text");
  });

  it("decodes HTML entities", () => {
    assert.equal(htmlToMarkdown("&amp; &lt; &gt; &quot; &#39;"), "& < > \" '");
    assert.equal(htmlToMarkdown("hello&nbsp;world"), "hello world");
  });

  it("handles empty string", () => {
    assert.equal(htmlToMarkdown(""), "");
  });

  it("handles a typical Shopify product description", () => {
    const html =
      "<p>A beautiful <strong>antique</strong> clock.</p><p>Perfect for collectors.</p>";
    const expected =
      "A beautiful **antique** clock.\n\nPerfect for collectors.";
    assert.equal(htmlToMarkdown(html), expected);
  });
});

describe("transformProduct", () => {
  it("transforms a product with all fields", () => {
    const product = makeProduct();
    const result = transformProduct(
      product,
      ["https://cdn.shopify.com/clock-1.jpg"],
      "29.99",
      "en",
      "EUR",
      "my-shop.myshopify.com",
    );

    assert.equal(result.shopsProductId, "12345");
    assert.deepEqual(result.title, { text: "Antique Clock", language: "en" });
    assert.equal(result.state, "AVAILABLE");
    assert.equal(
      result.url,
      "https://my-shop.myshopify.com/products/antique-clock",
    );
    assert.deepEqual(result.images, ["https://cdn.shopify.com/clock-1.jpg"]);
    assert.deepEqual(result.price, { amount: 2999, currency: "EUR" });
  });

  it("uses the shop's locale for language", () => {
    const result = transformProduct(
      makeProduct(),
      [],
      null,
      "de",
      "EUR",
      "shop.com",
    );
    assert.equal(result.title?.language, "de");
  });

  it("converts description HTML to markdown", () => {
    const result = transformProduct(
      makeProduct(),
      [],
      null,
      "en",
      "EUR",
      "shop.com",
    );
    assert.equal(result.description?.text, "A beautiful **antique** clock.");
  });

  it("uses fallback URL when onlineStoreUrl is null", () => {
    const product = makeProduct({ onlineStoreUrl: null });
    const result = transformProduct(
      product,
      [],
      null,
      "en",
      "EUR",
      "my-shop.myshopify.com",
    );
    assert.equal(result.url, "https://my-shop.myshopify.com/products/12345");
  });

  it("handles no variant price", () => {
    const result = transformProduct(
      makeProduct(),
      [],
      null,
      "en",
      "EUR",
      "shop.com",
    );
    assert.equal(result.price, undefined);
  });

  it("handles zero price", () => {
    const result = transformProduct(
      makeProduct(),
      [],
      "0.00",
      "en",
      "EUR",
      "shop.com",
    );
    assert.deepEqual(result.price, { amount: 0, currency: "EUR" });
  });

  it("skips price for unsupported currencies", () => {
    const result = transformProduct(
      makeProduct(),
      [],
      "10.00",
      "en",
      "XYZ",
      "shop.com",
    );
    assert.equal(result.price, undefined);
  });

  it("maps ACTIVE + 0 inventory to SOLD", () => {
    const product = makeProduct({ status: "ACTIVE", totalInventory: 0 });
    const result = transformProduct(product, [], null, "en", "EUR", "shop.com");
    assert.equal(result.state, "SOLD");
  });

  it("maps ACTIVE + null inventory (untracked) to AVAILABLE", () => {
    const product = makeProduct({ status: "ACTIVE", totalInventory: null });
    const result = transformProduct(product, [], null, "en", "EUR", "shop.com");
    assert.equal(result.state, "AVAILABLE");
  });

  it("maps DRAFT to LISTED", () => {
    const product = makeProduct({ status: "DRAFT" });
    const result = transformProduct(product, [], null, "en", "EUR", "shop.com");
    assert.equal(result.state, "LISTED");
  });
});

describe("parseProductsFromJsonl", () => {
  it("parses products with images and variants from JSONL", () => {
    const jsonl = [
      '{"id":"gid://shopify/Product/1","title":"Clock","descriptionHtml":"<p>Nice</p>","status":"ACTIVE","totalInventory":3,"onlineStoreUrl":"https://shop.com/1"}',
      '{"id":"gid://shopify/ProductImage/10","url":"https://cdn.shopify.com/img1.jpg","__parentId":"gid://shopify/Product/1"}',
      '{"id":"gid://shopify/ProductImage/11","url":"https://cdn.shopify.com/img2.jpg","__parentId":"gid://shopify/Product/1"}',
      '{"id":"gid://shopify/ProductVariant/100","price":"49.99","__parentId":"gid://shopify/Product/1"}',
    ].join("\n");

    const { products, images, variants } = parseProductsFromJsonl(jsonl);

    assert.equal(products.length, 1);
    assert.equal(products[0].title, "Clock");
    assert.deepEqual(images.get("gid://shopify/Product/1"), [
      "https://cdn.shopify.com/img1.jpg",
      "https://cdn.shopify.com/img2.jpg",
    ]);
    assert.equal(variants.get("gid://shopify/Product/1"), "49.99");
  });

  it("handles multiple products", () => {
    const jsonl = [
      '{"id":"gid://shopify/Product/1","title":"A","descriptionHtml":"","status":"ACTIVE","totalInventory":1,"onlineStoreUrl":null}',
      '{"id":"gid://shopify/Product/2","title":"B","descriptionHtml":"","status":"DRAFT","totalInventory":0,"onlineStoreUrl":null}',
    ].join("\n");

    const { products } = parseProductsFromJsonl(jsonl);
    assert.equal(products.length, 2);
  });

  it("handles empty JSONL", () => {
    const { products, images, variants } = parseProductsFromJsonl("");
    assert.equal(products.length, 0);
    assert.equal(images.size, 0);
    assert.equal(variants.size, 0);
  });

  it("initializes empty image array for products without images", () => {
    const jsonl =
      '{"id":"gid://shopify/Product/1","title":"A","descriptionHtml":"","status":"ACTIVE","totalInventory":1,"onlineStoreUrl":null}';

    const { images } = parseProductsFromJsonl(jsonl);
    assert.deepEqual(images.get("gid://shopify/Product/1"), []);
  });

  it("only takes the first variant price per product", () => {
    const jsonl = [
      '{"id":"gid://shopify/Product/1","title":"A","descriptionHtml":"","status":"ACTIVE","totalInventory":1,"onlineStoreUrl":null}',
      '{"id":"gid://shopify/ProductVariant/10","price":"10.00","__parentId":"gid://shopify/Product/1"}',
      '{"id":"gid://shopify/ProductVariant/11","price":"20.00","__parentId":"gid://shopify/Product/1"}',
    ].join("\n");

    const { variants } = parseProductsFromJsonl(jsonl);
    assert.equal(variants.get("gid://shopify/Product/1"), "10.00");
  });
});

describe("backfill context KV helpers", () => {
  it("round-trips backfill context through KV", async () => {
    const kv = makeKv();
    const ctx: BackfillContext = {
      shopId: "550e8400-e29b-41d4-a716-446655440000",
      apiKey: "aurahistoria_partner_test",
      apiBaseUrl: "https://api.test.com",
      primaryLocale: "de",
      currencyCode: "EUR",
      shopDomain: "my-shop.myshopify.com",
      bulkOperationId: "gid://shopify/BulkOperation/123",
      createdAt: new Date().toISOString(),
    };

    await storeBackfillContext(kv as never, "my-shop.myshopify.com", ctx);
    const loaded = await loadBackfillContext(
      kv as never,
      "my-shop.myshopify.com",
    );

    assert.deepEqual(loaded, ctx);
  });

  it("returns null when no context exists", async () => {
    const kv = makeKv();
    const loaded = await loadBackfillContext(kv as never, "no-shop.com");
    assert.equal(loaded, null);
  });

  it("clears stored context", async () => {
    const kv = makeKv();
    const ctx: BackfillContext = {
      shopId: "test",
      apiKey: "test",
      apiBaseUrl: "test",
      primaryLocale: "en",
      currencyCode: "EUR",
      shopDomain: "shop.com",
      bulkOperationId: "test",
      createdAt: new Date().toISOString(),
    };

    await storeBackfillContext(kv as never, "shop.com", ctx);
    await clearBackfillContext(kv as never, "shop.com");
    const loaded = await loadBackfillContext(kv as never, "shop.com");
    assert.equal(loaded, null);
  });

  it("stores with TTL", async () => {
    const kv = makeKv();
    await storeBackfillContext(kv as never, "shop.com", {
      shopId: "test",
      apiKey: "test",
      apiBaseUrl: "test",
      primaryLocale: "en",
      currencyCode: "EUR",
      shopDomain: "shop.com",
      bulkOperationId: "test",
      createdAt: new Date().toISOString(),
    });

    const putCall = kv.put.mock.calls[0];
    assert.ok(putCall);
    assert.deepEqual(putCall.arguments[2], { expirationTtl: 3600 });
  });
});

describe("fetchShopMetadata", () => {
  it("extracts primary locale and currency from GraphQL response", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(async () => ({
      data: {
        shopLocales: [
          { locale: "de", primary: true },
          { locale: "en", primary: false },
        ],
        shop: { currencyCode: "EUR" },
      },
    }));

    const metadata = await fetchShopMetadata(graphqlRequest);
    assert.equal(metadata.primaryLocale, "de");
    assert.equal(metadata.currencyCode, "EUR");
  });

  it("falls back to English and EUR when no data", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(async () => ({
      data: { shopLocales: [], shop: {} },
    }));

    const metadata = await fetchShopMetadata(graphqlRequest);
    assert.equal(metadata.primaryLocale, "en");
    assert.equal(metadata.currencyCode, "EUR");
  });

  it("throws on GraphQL errors", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(async () => ({
      errors: [{ message: "Unauthorized" }],
    }));

    await assert.rejects(() => fetchShopMetadata(graphqlRequest), {
      message: /Unauthorized/,
    });
  });
});

describe("submitBulkOperation", () => {
  it("returns the bulk operation ID on success", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(async () => ({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: {
            id: "gid://shopify/BulkOperation/456",
            status: "CREATED",
          },
          userErrors: [],
        },
      },
    }));

    const id = await submitBulkOperation(graphqlRequest);
    assert.equal(id, "gid://shopify/BulkOperation/456");
  });

  it("throws on GraphQL errors", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(async () => ({
      errors: [{ message: "Rate limited" }],
    }));

    await assert.rejects(() => submitBulkOperation(graphqlRequest), {
      message: /Rate limited/,
    });
  });

  it("throws on user errors", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(async () => ({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ field: ["query"], message: "Already running" }],
        },
      },
    }));

    await assert.rejects(() => submitBulkOperation(graphqlRequest), {
      message: /Already running/,
    });
  });

  it("throws when no operation ID returned", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(async () => ({
      data: {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [],
        },
      },
    }));

    await assert.rejects(() => submitBulkOperation(graphqlRequest), {
      message: /no operation ID/,
    });
  });
});

describe("triggerBackfill", () => {
  it("does not throw on errors (fire-and-forget)", async () => {
    const graphqlRequest: GraphqlRequestFn = mock.fn(async () => ({
      errors: [{ message: "Something broke" }],
    }));
    const kv = makeKv();

    await triggerBackfill(
      graphqlRequest,
      kv as never,
      "shop.com",
      "shop-id",
      "api-key",
      "https://api.test.com",
    );
  });

  it("stores backfill context in KV on success", async () => {
    let callCount = 0;
    const graphqlRequest: GraphqlRequestFn = mock.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          data: {
            shopLocales: [{ locale: "de", primary: true }],
            shop: { currencyCode: "EUR" },
          },
        };
      }
      return {
        data: {
          bulkOperationRunQuery: {
            bulkOperation: {
              id: "gid://shopify/BulkOperation/789",
              status: "CREATED",
            },
            userErrors: [],
          },
        },
      };
    });
    const kv = makeKv();

    await triggerBackfill(
      graphqlRequest,
      kv as never,
      "my-shop.myshopify.com",
      "shop-id-123",
      "api-key-456",
      "https://api.test.com",
    );

    const stored = await loadBackfillContext(
      kv as never,
      "my-shop.myshopify.com",
    );
    assert.ok(stored);
    assert.equal(stored.shopId, "shop-id-123");
    assert.equal(stored.primaryLocale, "de");
    assert.equal(stored.currencyCode, "EUR");
    assert.equal(stored.bulkOperationId, "gid://shopify/BulkOperation/789");
  });
});

describe("backfill configuration", () => {
  it("includes AURA_HISTORIA_API_BASE_URL in wrangler vars", () => {
    const content = readFileSync(
      resolve(process.cwd(), "wrangler.jsonc"),
      "utf8",
    );
    assert.match(content, /AURA_HISTORIA_API_BASE_URL/);
  });

  it("has a pinned commit in openapi-ts config", () => {
    const content = readFileSync(
      resolve(process.cwd(), "openapi-ts.config.ts"),
      "utf8",
    );
    assert.match(content, /SWAGGER_COMMIT/);
    assert.match(content, /[0-9a-f]{40}/);
  });

  it("has an openapi:generate script in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    );
    assert.ok(pkg.scripts["openapi:generate"]);
  });

  it("declares bulk_operations/finish webhook in shopify.app.toml", () => {
    const content = readFileSync(
      resolve(process.cwd(), "shopify.app.toml"),
      "utf8",
    );
    assert.match(content, /bulk_operations\/finish/);
    assert.match(content, /webhooks\/bulk-operations\/finish/);
  });

  it("declares bulk_operations/finish webhook in shopify.app.prod.toml", () => {
    const content = readFileSync(
      resolve(process.cwd(), "shopify.app.prod.toml"),
      "utf8",
    );
    assert.match(content, /bulk_operations\/finish/);
    assert.match(content, /webhooks\/bulk-operations\/finish/);
  });

  it("includes read_locales scope in shopify.app.toml", () => {
    const content = readFileSync(
      resolve(process.cwd(), "shopify.app.toml"),
      "utf8",
    );
    assert.match(content, /read_locales/);
  });

  it("includes read_locales scope in shopify.app.prod.toml", () => {
    const content = readFileSync(
      resolve(process.cwd(), "shopify.app.prod.toml"),
      "utf8",
    );
    assert.match(content, /read_locales/);
  });
});
