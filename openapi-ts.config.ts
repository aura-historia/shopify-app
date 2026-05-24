import { defineConfig } from "@hey-api/openapi-ts";

// Pinned to a specific commit for reproducible client generation.
// Regenerate with: npx @hey-api/openapi-ts
const SWAGGER_COMMIT = "9beec6fb1886ec9672981a0577f92c080a434eac";

export default defineConfig({
  input: `https://raw.githubusercontent.com/aura-historia/internal-api/${SWAGGER_COMMIT}/swagger.yaml`,
  output: "app/generated/api",
  plugins: ["@hey-api/client-fetch"],
});
