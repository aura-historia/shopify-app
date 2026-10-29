import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it, mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, Outlet } from "react-router";

// Node cannot load the stylesheets the route modules import; titles do not
// depend on them.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".module.css"))
      return {
        url: "data:text/javascript,export default {}",
        shortCircuit: true,
      };
    if (specifier.endsWith(".css?url"))
      return {
        url: "data:text/javascript,export default '/tokens.css'",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const root = await import("../app/root");
const embedded = await import("../app/routes/app");
const login = await import("../app/routes/auth.login/route");
const callback = await import("../app/routes/oauth.callback");
const success = await import("../app/routes/success");

// The stub has no client build, so <Scripts> preloads empty hrefs and React
// warns about each one.
const consoleError = console.error;
mock.method(console, "error", (...args: unknown[]) => {
  if (!String(args[0]).startsWith('An empty string ("") was passed to the'))
    consoleError(...args);
});

const code = "synthetic-authorization-code";
const state = "synthetic-oauth-state";
const errorText = "synthetic-error-text";
const shop = "synthetic-shop.myshopify.com";

const Empty = () => null;
const Stub = createRoutesStub([
  {
    id: "root",
    path: "/",
    meta: root.meta,
    links: root.links,
    Component: root.default,
    children: [
      { id: "routes/_index/route", index: true, Component: Empty },
      {
        id: "routes/auth.login/route",
        path: "auth/login",
        meta: login.meta,
        Component: Empty,
      },
      {
        id: "routes/oauth.callback",
        path: "oauth/callback",
        meta: callback.meta,
        Component: Empty,
      },
      {
        id: "routes/success",
        path: "success",
        meta: success.meta,
        Component: Empty,
      },
      {
        id: "routes/app",
        path: "app",
        meta: embedded.meta,
        Component: Outlet,
        ErrorBoundary: Empty,
        children: [{ id: "routes/app._index", index: true, Component: Empty }],
      },
    ],
  },
]);

function documentTitles(
  url: string,
  hydrationData: Parameters<typeof Stub>[0]["hydrationData"] = {},
) {
  const html = renderToStaticMarkup(
    createElement(Stub, { initialEntries: [url], hydrationData }),
  );
  const head = /<head>(.*)<\/head>/s.exec(html)?.[1] ?? "";
  assert.equal(
    html.split("<title>").length,
    head.split("<title>").length,
    "every <title> belongs in <head>",
  );
  return [...head.matchAll(/<title>(.*?)<\/title>/g)].map(([, title]) => title);
}

describe("document titles", () => {
  it("names the public landing page", () => {
    assert.deepEqual(documentTitles("/"), ["Aura Historia Partner Connect"]);
  });

  it("gives login, callback and success documents static titles", () => {
    assert.deepEqual(
      documentTitles(`/auth/login?shop=${shop}`, {
        loaderData: {
          "routes/auth.login/route": { errors: { shop: errorText } },
        },
      }),
      ["Install from Shopify · Aura Historia Partner Connect"],
    );
    assert.deepEqual(
      documentTitles(
        `/oauth/callback?code=${code}&state=${state}&error_description=${errorText}`,
        {
          loaderData: {
            "routes/oauth.callback": { ok: false, message: errorText },
          },
        },
      ),
      ["Connection failed · Aura Historia Partner Connect"],
    );
    assert.deepEqual(
      documentTitles(
        `/success?shop=${shop}&integration=oauth-config-missing&missing=${errorText}`,
        {
          loaderData: {
            "routes/success": {
              shop,
              appUrl: null,
              integration: "oauth-config-missing",
              missingConfig: errorText,
            },
          },
        },
      ),
      ["Installation approved · Aura Historia Partner Connect"],
    );
  });

  it("leaves Admin app documents untitled for App Bridge", () => {
    assert.deepEqual(documentTitles(`/app?shop=${shop}&host=aG9zdA`), []);
    assert.deepEqual(
      documentTitles("/app", { errors: { "routes/app": new Error("boom") } }),
      [],
    );
  });
});
