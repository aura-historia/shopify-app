import { defineConfig } from "@hey-api/openapi-ts";

// Pinned to a specific commit for reproducible client generation.
// Regenerate with: npx @hey-api/openapi-ts
const SWAGGER_COMMIT = "c50db69e7e66a739c3b53ba86c9813261dc1c70a";

export default defineConfig({
  input: `https://raw.githubusercontent.com/aura-historia/internal-api/${SWAGGER_COMMIT}/swagger.yaml`,
  output: "app/generated/api",
  plugins: ["@hey-api/client-fetch"],
});
