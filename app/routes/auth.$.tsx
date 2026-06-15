import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { markShopifyInstallLanding } from "../shop-credentials.server";
import { getShopify } from "../shopify.server";
import {
  createShopifyAdminAppRootUrl,
  getShopifyStoreName,
} from "../shopify-admin-url";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const { redirect, session } =
    await getShopify(context).authenticate.admin(request);

  if (url.pathname.endsWith("/callback")) {
    await markShopifyInstallLanding(context.cloudflare.env.KV, session.shop);

    const adminAppUrl = createShopifyAdminAppRootUrl(
      getShopifyStoreName(session.shop),
    );

    return redirect(adminAppUrl.toString());
  }

  // Auth succeeded but we're not at the callback path.
  // Redirect to the embedded admin with the original query params so
  // app.tsx can finish the AppBridge session setup.
  return redirect(`/app?${url.searchParams.toString()}`);
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
