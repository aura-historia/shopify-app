import { defineConfig } from "@hey-api/openapi-ts";

// Pinned to a specific commit for reproducible client generation.
// Regenerate with: npm run openapi:generate
const SWAGGER_COMMIT = "8f39fcd549ebc49608bb2722bb219e623c6742e2";

export default defineConfig({
  input: `https://raw.githubusercontent.com/aura-historia/backend/${SWAGGER_COMMIT}/docs/swagger.yaml`,
  output: "app/generated/api",
  plugins: ["@hey-api/client-fetch"],
});
