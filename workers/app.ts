import { createRequestHandler } from "react-router";
import { protectPrivateResponse } from "../app/iframe-protection.server";
import type { CloudflareShopifyEnv } from "../app/shopify.server";

export { CatalogImporter } from "./catalog-importer";
export { ShopCoordinator } from "./shop-coordinator";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: CloudflareShopifyEnv;
      ctx: Pick<ExecutionContext, "waitUntil">;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(
    request: Request,
    env: CloudflareShopifyEnv,
    ctx: ExecutionContext,
  ) {
    const response = await requestHandler(request, {
      cloudflare: { env, ctx },
    });
    return protectPrivateResponse(request, response);
  },
} satisfies ExportedHandler<CloudflareShopifyEnv>;
