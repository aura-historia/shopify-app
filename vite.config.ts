import { reactRouter } from "@react-router/dev/vite";
import { type UserConfig, defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

import { cloudflare } from "@cloudflare/vite-plugin";


if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  process.env.HOST = undefined;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;
const frontendPort = process.env.FRONTEND_PORT
  ? Number.parseInt(process.env.FRONTEND_PORT, 10)
  : undefined;

const hmrConfig =
  host === "localhost"
    ? {
        protocol: "ws",
        host: "localhost",
        port: 64999,
        clientPort: 64999,
      }
    : {
        protocol: "wss",
        host,
        port: frontendPort || 8002,
        clientPort: 443,
      };

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules", "workers"],
    },
  },
  plugins: [
    reactRouter(),
    tsconfigPaths(),
    cloudflare({
      viteEnvironment: {
        name: "ssr",
      },
    }),
  ],
  build: {
    assetsInlineLimit: 0,
  },
}) satisfies UserConfig;
