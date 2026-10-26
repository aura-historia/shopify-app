import { defineConfig } from "@hey-api/openapi-ts";

// Pinned to a specific commit for reproducible client generation.
// Regenerate with: npm run openapi:generate
const SWAGGER_COMMIT = "597425dcca064e7128072b988042ab3f9b1aedd1";

export default defineConfig({
  input: `https://raw.githubusercontent.com/aura-historia/backend/${SWAGGER_COMMIT}/docs/swagger.yaml`,
  output: "app/generated/api",
  plugins: ["@hey-api/client-fetch"],
});
