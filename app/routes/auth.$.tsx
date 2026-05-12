import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { getShopify } from "../shopify.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const { redirect, session } =
    await getShopify(context).authenticate.admin(request);

  if (url.pathname.endsWith("/callback")) {
    const successParams = new URLSearchParams();
    successParams.set("shop", session.shop);

    const host = url.searchParams.get("host");
    if (host) {
      successParams.set("host", host);
    }

    return redirect(`/success?${successParams.toString()}`, {
      target: "_parent",
    });
  }

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
