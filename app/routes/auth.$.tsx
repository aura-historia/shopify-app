import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { getShopify } from "../shopify.server";

const SHOPIFY_ADMIN_APP_URL =
  "https://admin.shopify.com/apps/aura-historia-partner-connect";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const { redirect } = await getShopify(context).authenticate.admin(request);

  if (url.pathname.endsWith("/callback")) {
    return redirect(SHOPIFY_ADMIN_APP_URL);
  }

  // Auth succeeded but we're not at the callback path.
  // Redirect to the embedded admin with the original query params so
  // app.tsx can finish the AppBridge session setup.
  return redirect(`/app?${url.searchParams.toString()}`);
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
