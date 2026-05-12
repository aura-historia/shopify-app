import { createRequestHandler } from "react-router";
import type { CloudflareShopifyEnv } from "../app/shopify.server";

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
    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
};
