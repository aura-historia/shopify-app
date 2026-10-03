import { defineConfig } from "@hey-api/openapi-ts";

// Pinned to a specific commit for reproducible client generation.
// Regenerate with: npm run openapi:generate
const SWAGGER_COMMIT = "792444f6d62cfb9f8dd4dc44ffb47a420de54cad";

export default defineConfig({
  input: `https://raw.githubusercontent.com/aura-historia/backend/${SWAGGER_COMMIT}/docs/swagger.yaml`,
  output: "app/generated/api",
  plugins: ["@hey-api/client-fetch"],
});
