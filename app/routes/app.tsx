import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type {
  HeadersFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { getShopify, getShopifyApiKey } from "../shopify.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  await getShopify(context).authenticate.admin(request);

  return { apiKey: getShopifyApiKey(context) };
};

// App Bridge can take the Admin title bar from document.title, so Admin app
// documents stay untitled and <s-page heading> keeps owning it.
export const meta: MetaFunction = () => [];

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  const headers = boundary.headers(headersArgs);
  headers.set("Cache-Control", "private, no-store");
  return headers;
};
