import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { buildAuraHistoriaOAuthAuthorizeUrl } from "../oauth.server";
import { getShopify } from "../shopify.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const { redirect, session } =
    await getShopify(context).authenticate.admin(request);

  if (url.pathname.endsWith("/callback")) {
    const authorization = await buildAuraHistoriaOAuthAuthorizeUrl(
      context.cloudflare.env.KV,
      context.cloudflare.env,
      session.shop,
    );

    if (authorization.isReady) {
      return redirect(authorization.url.toString(), {
        target: "_parent",
      });
    }

    const successParams = new URLSearchParams();
    successParams.set("shop", session.shop);
    successParams.set("integration", "oauth-config-missing");
    successParams.set("missing", authorization.missing.join(","));

    const host = url.searchParams.get("host");
    if (host) {
      successParams.set("host", host);
    }

    return redirect(`/success?${successParams.toString()}`, {
      target: "_parent",
    });
  }

  // Auth succeeded but we're not at the callback path.
  // Redirect to the embedded admin with the original query params so
  // app.tsx can finish the AppBridge session setup.
  return redirect(`/app?${url.searchParams.toString()}`);
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
