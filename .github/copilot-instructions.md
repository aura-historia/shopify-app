# GitHub Copilot instructions for Aura Historia Partner Connect

## Product context

- This is a minimal public Shopify app.
- Merchants install it so Aura Historia receives Shopify product lifecycle events through Amazon EventBridge.
- AWS infrastructure, EventBridge rules, and downstream consumers live in another repository.

## Architecture constraints

- Keep the app minimal: authentication, embedded app shell, Prisma session storage, and uninstall cleanup.
- Product webhooks and compliance webhooks are declared in `shopify.app.toml`.
- `app/routes/webhooks.app.uninstalled.tsx` is the only webhook processed directly by this app.
- Avoid adding demo pages, sample mutations, placeholder business logic, or unnecessary UI.

## Local development rules

- The default development flow must keep working with `shopify app dev --use-localhost`.
- Because Shopify localhost mode cannot directly invoke app webhooks, keep the `app/uninstalled` subscription on a deployed HTTPS app URL instead of a relative localhost path unless the local-development strategy changes deliberately.
- If direct webhook testing is needed during development, prefer a separate tunnel-based workflow instead of breaking localhost mode.

## Shopify-specific rules

- Preserve the mandatory public app compliance subscriptions:
  - `customers/data_request`
  - `customers/redact`
  - `shop/redact`
- Preserve the product EventBridge subscriptions:
  - `products/create`
  - `products/update`
  - `products/delete`
- Preserve the `app/uninstalled` subscription so session cleanup continues to work.
- Keep `app/shopify.server.ts` API version aligned with `shopify.app.toml`.
- Do not widen Shopify access scopes unless there is a documented product requirement.
- If you change authentication behavior, keep `authPathPrefix = "/auth"` and ensure the redirect URLs still include the callback route.

## Preferred implementation style

- Prefer configuration changes over new runtime code when possible.
- Prefer small React Router loaders/actions over new abstractions.
- Prefer server-side logic and static UI over client-side state.
- Add new runtime dependencies only when they are clearly necessary.

## Tooling rules

- Use Biome for linting.
- Keep package and CI Node versions aligned with `package.json` engines (`>=20.19 <22 || >=22.12`).
- Keep `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build` passing after meaningful changes.
- Keep the GitHub Actions CI workflow current when changing project scripts or quality checks.

## Testing expectations

- Add or update tests when changing login validation, Shopify app configuration, package scripts, or CI-sensitive tooling.
- Prefer focused unit tests and config-guard tests over large test harnesses.
