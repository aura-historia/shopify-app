import { boundary } from "@shopify/shopify-app-react-router/server";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const { redirect, session } = await authenticate.admin(request);

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
