import { defineConfig } from "@hey-api/openapi-ts";

// Pinned to a specific commit for reproducible client generation.
// Regenerate with: npx @hey-api/openapi-ts
const SWAGGER_COMMIT = "1ad5e8660d42f85a5633c185f8c2c94ac91122bd";

export default defineConfig({
  input: `https://raw.githubusercontent.com/aura-historia/backend/${SWAGGER_COMMIT}/docs/swagger.yaml`,
  output: "app/generated/api",
  plugins: ["@hey-api/client-fetch"],
});
