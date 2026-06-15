import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

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
  resolve: {
    // Tunnel mode runs the app through Vite's SSR dev pipeline. Dedupe these
    // core packages so React Router hooks and Shopify's AppProvider always use
    // the same React dispatcher/context instance.
    dedupe: ["react", "react-dom", "react-router"],
  },
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
}) satisfies UserConfig;
