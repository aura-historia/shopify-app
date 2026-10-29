import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, Meta, Outlet } from "react-router";

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

const Empty = () => null;
const Stub = createRoutesStub([
  {
    id: "root",
    path: "/",
    meta: root.meta,
    Component: () =>
      createElement(Fragment, null, createElement(Meta), createElement(Outlet)),
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

function renderHead(
  url: string,
  hydrationData: Parameters<typeof Stub>[0]["hydrationData"] = {},
) {
  return renderToStaticMarkup(
    createElement(Stub, { initialEntries: [url], hydrationData }),
  );
}

describe("document titles", () => {
  it("names the public landing page", () => {
    assert.equal(
      renderHead("/"),
      "<title>Aura Historia Partner Connect</title>",
    );
  });

  it("gives login, callback and success documents static titles", () => {
    const secrets = [
      "synthetic-code-marker",
      "synthetic-state-marker",
      "synthetic-error-marker",
      "synthetic-shop-marker",
    ];
    const cases = [
      {
        url: `/auth/login?shop=${secrets[3]}.myshopify.com`,
        loaderData: {
          "routes/auth.login/route": { errors: { shop: secrets[2] } },
        },
        title: "Install from Shopify · Aura Historia Partner Connect",
      },
      {
        url: `/oauth/callback?code=${secrets[0]}&state=${secrets[1]}&error_description=${secrets[2]}`,
        loaderData: {
          "routes/oauth.callback": { ok: false, message: secrets[2] },
        },
        title: "Connection failed · Aura Historia Partner Connect",
      },
      {
        url: `/success?shop=${secrets[3]}.myshopify.com&integration=oauth-config-missing&missing=${secrets[2]}`,
        loaderData: {
          "routes/success": {
            shop: `${secrets[3]}.myshopify.com`,
            appUrl: null,
            integration: "oauth-config-missing",
            missingConfig: secrets[2],
          },
        },
        title: "Installation approved · Aura Historia Partner Connect",
      },
    ];

    for (const { url, loaderData, title } of cases) {
      assert.equal(renderHead(url, { loaderData }), `<title>${title}</title>`);
    }
  });

  it("leaves embedded app documents untitled for App Bridge", () => {
    assert.equal(renderHead("/app?embedded=1&host=aG9zdA"), "");
    assert.equal(
      renderHead("/app", { errors: { "routes/app": new Error("boom") } }),
      "",
    );
  });
});
