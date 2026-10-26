import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import AppIndex from "../app/routes/app._index";

function renderHome(phase: string | null, backfill: string) {
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
            catalogImport: phase ? { phase, total: 1, failed: 0 } : null,
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
            ? /Last import: 1 products processed/
            : /Catalog import needs attention/,
      );
    }
  });
  it("still reports a failed retry when the previous import succeeded", () => {
    const html = renderHome("submitted", "not_queued");
    assert.match(html, /Last import: 1 products processed/);
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
