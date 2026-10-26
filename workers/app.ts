import { createRequestHandler } from "react-router";
import { protectPrivateResponse } from "../app/iframe-protection.server";
import type { CloudflareShopifyEnv } from "../app/shopify.server";

export { ShopCoordinator } from "./shop-coordinator";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: CloudflareShopifyEnv;
      ctx: unknown;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

export default {
  async fetch(request: Request, env: CloudflareShopifyEnv, ctx: unknown) {
    const response = await requestHandler(request, {
      cloudflare: { env, ctx },
    });
    return protectPrivateResponse(request, response);
  },
};
