import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import AppIndex from "../app/routes/app._index";
import { createShopifyPermissionsUrl } from "../app/shopify-admin-url";

function renderHome(
  phase: string | null,
  backfill: string,
  overrides: {
    publication?: unknown;
    permissionsUrl?: string | null;
    catalogImport?: unknown;
  } = {},
) {
  const router = createMemoryRouter(
    [{ id: "app", path: "/app", Component: AppIndex }],
    {
      initialEntries: [`/app?backfill=${backfill}`],
      hydrationData: {
        loaderData: {
          app: {
            shop: "example.myshopify.com",
            credentials: {
              listingSourceId: `ls_${"0".repeat(26)}`,
              updatedAt: "2026-10-26T00:00:00Z",
            },
            integration: { status: "connected", backfill },
            shipping: null,
            publication: null,
            permissionsUrl: null,
            catalogImport: phase
              ? { phase, total: 1, failed: 0, eligible: 1, withdrawn: 0 }
              : null,
            ...overrides,
          },
        },
      },
    },
  );
  try {
    return renderToStaticMarkup(createElement(RouterProvider, { router }));
  } finally {
    router.dispose();
  }
}

describe("catalog progress in the embedded home", () => {
  it("uses saved progress ahead of the original queued redirect", () => {
    for (const phase of ["processing", "submitted", "failed"]) {
      const html = renderHome(phase, "queued");
      assert.doesNotMatch(html, /Initial product backfill was queued/);
      assert.match(
        html,
        phase === "processing"
          ? /The catalog is being submitted/
          : phase === "submitted"
            ? /Last import: 1 Shopify products checked/
            : /Catalog import needs attention/,
      );
    }
  });
  it("still reports a failed retry when the previous import succeeded", () => {
    const html = renderHome("submitted", "not_queued");
    assert.match(html, /Last import: 1 Shopify products checked/);
    assert.match(html, /Catalog import needs attention/);
  });
  it("retains the redirect feedback when no saved progress is available", () => {
    assert.match(
      renderHome(null, "queued"),
      /Initial product backfill was queued/,
    );
    assert.match(
      renderHome(null, "not_queued"),
      /Catalog import needs attention/,
    );
  });
});

describe("Aura channel selection in the embedded home", () => {
  it("labels Shopify's published count and links the channel's bulk editor", () => {
    const html = renderHome(null, "", {
      publication: {
        state: "ready",
        count: 12,
        atLeast: false,
        editorUrl:
          "https://admin.shopify.com/store/example/bulk?edit=publications.1.published_at",
      },
    });
    assert.match(
      html,
      /12 active products are published to the Aura Historia channel/,
    );
    assert.match(html, /not an import count/);
    assert.match(html, /Manage products in Shopify bulk editor/);
    assert.match(html, /unpublishing withdraws it/);
  });
  it("asks for the missing permission instead of reporting a zero-product import", () => {
    const html = renderHome(null, "not_queued", {
      publication: { state: "missing_scope" },
      catalogImport: {
        phase: "failed",
        total: 0,
        failed: 0,
        error: "MISSING_SCOPE",
      },
    });
    assert.match(html, /Shopify permission required/);
    assert.match(html, /Catalog import needs attention/);
    assert.doesNotMatch(html, /Manage products in Shopify bulk editor/);
    assert.doesNotMatch(html, /Last import/);
  });
  it("links the missing permission to Shopify's approval instead of a retry only", () => {
    const permissionsUrl = createShopifyPermissionsUrl(
      "example",
      "c16ab3575bcbffd285d378b5caaeb0f8",
    ).toString();
    assert.equal(
      permissionsUrl,
      "https://admin.shopify.com/store/example/oauth/install?client_id=c16ab3575bcbffd285d378b5caaeb0f8",
    );
    const html = renderHome(null, "not_queued", {
      publication: { state: "missing_scope" },
      permissionsUrl,
      catalogImport: {
        phase: "failed",
        total: 0,
        failed: 0,
        error: "MISSING_SCOPE",
      },
    });
    assert.match(html, /product listings and publications/);
    assert.match(html, /Review app permissions in Shopify/);
    assert.ok(
      html.includes(`href="${permissionsUrl.replaceAll("&", "&amp;")}"`),
    );
    assert.match(html, /approve the app&#x27;s updated permissions/i);
    // Without a missing grant there is nothing to approve.
    assert.doesNotMatch(
      renderHome(null, "", { publication: { state: "unavailable" } }),
      /Review app permissions in Shopify/,
    );
  });
  it("reports a missing channel publication", () => {
    const html = renderHome(null, "", {
      publication: { state: "missing_publication" },
    });
    assert.match(html, /Sales channel not found/);
  });
  it("offers setup instead of product selection without a channel connection", () => {
    const html = renderHome(null, "not_queued", {
      publication: { state: "missing_channel" },
      catalogImport: {
        phase: "failed",
        total: 0,
        failed: 0,
        error: "MISSING_CHANNEL",
      },
    });
    assert.match(html, /Sales channel not set up/);
    assert.match(html, /Import the catalog again to set it up/);
    assert.match(html, /Import catalog again/);
    assert.doesNotMatch(html, /Manage products in Shopify bulk editor/);
    assert.doesNotMatch(html, /Last import/);
  });
  it("explains a channel Shopify refused as a retryable failure", () => {
    const html = renderHome(null, "not_queued", {
      publication: { state: "missing_channel" },
      catalogImport: {
        phase: "failed",
        total: 0,
        failed: 0,
        error: "CHANNEL_REJECTED",
      },
    });
    assert.match(html, /Catalog import needs attention/);
    assert.match(
      html,
      /Shopify did not accept the Aura Historia sales channel/,
    );
    assert.match(html, /Your store settings are unchanged/);
    assert.doesNotMatch(html, /Shopify markets/);
  });
  it("explains an incomplete export as a retryable failure", () => {
    const html = renderHome(null, "", {
      catalogImport: {
        phase: "failed",
        total: 4,
        failed: 1,
        eligible: 2,
        withdrawn: 1,
        error: "INCOMPLETE_EXPORT",
      },
    });
    assert.match(html, /Catalog import needs attention/);
    assert.match(html, /could not be verified as complete/);
    assert.match(html, /1 products could not be classified or submitted/);
  });
  it("separates eligible submissions from withdrawals in the last import", () => {
    const html = renderHome(null, "", {
      catalogImport: {
        phase: "submitted",
        total: 5,
        failed: 0,
        eligible: 3,
        withdrawn: 2,
        reconciled: true,
      },
    });
    assert.match(html, /5 Shopify products checked/);
    assert.match(html, /3 published to Aura Historia\s+submitted/);
    assert.match(html, /2 unpublished or\s+inactive products withdrawn/);
  });
});
