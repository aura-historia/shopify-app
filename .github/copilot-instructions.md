# GitHub Copilot instructions for the Aura Historia Shopify app

## Product context

- This is a minimal public Shopify app.
- Merchants install it so Aura Historia receives Shopify product listing events for its own sales channel through Amazon EventBridge.
- AWS infrastructure, EventBridge rules, and downstream consumers live in another repository.

## Architecture constraints

- Keep the app focused on authentication, the embedded app shell, KV session storage, initial catalog backfill, advertised shipping imports, and uninstall cleanup.
- Product webhooks and compliance webhooks are declared in `shopify.app.toml`.
- Uninstall, bulk-operation completion, shipping profile, market and scope-change webhooks are processed directly by this app. Product and compliance events use EventBridge.
- Shipping acquisition, mapping and publication share the implementation in `app/shipping`; per-shop Durable Objects coordinate offline Shopify access for catalog and shipping. Catalog exports are processed by the per-shop `CatalogImporter` in bounded, checkpointed alarm steps, never in a request's `waitUntil`. Keep provider credentials inside the app's protected sessions.
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
- Preserve the own-channel product listing EventBridge subscriptions (they require `read_product_listings`):
  - `product_listings/add`
  - `product_listings/update`
  - `product_listings/remove`
- Catalog imports admit only active products whose `publishedOnPublication` membership in the publication of the app's channel connection is explicitly true. Never fall back to all active products, `onlineStoreUrl`, generic Online Store filters, aggregate counts or the deprecated `currentAppInstallation.publication`.
- Keep `create_legacy_channel_on_app_install = false`. The app's single channel connection (handle `aura-historia`) is created or rebound with `channelCreate`/`channelUpdate` in `app/channel.server.ts`, only after Aura accepted the listing source's ingestion configuration, and its `accountId` is that listing source ID.
- Any store must be able to create the channel connection, whatever its market coverage: worldwide, a few countries or a single market. Keep every Shopify country in the `aura-historia` specification and `expectsOnlineStoreParity = false`: with parity required, Shopify refuses `channelCreate` unless every declared country has a matching region market. Never create, change or remove merchant markets for the channel.
- Preserve the `app/uninstalled` subscription so session cleanup continues to work.
- Keep `app/shopify.server.ts` API version aligned with `shopify.app.toml`.
- Keep production-only webhook differences in `shopify.app.prod.toml` instead of trying to drive EventBridge ARNs from `shopify.web.toml`.
- Do not widen Shopify access scopes unless there is a documented product requirement.
- Static webhook subscriptions need their topic's scope in `access_scopes.scopes`; Shopify rejects topics whose scope is only in `optional_scopes`. Keep `read_shipping` required for the profile subscriptions and `read_markets` for the market subscriptions, and mirror the scope list in the `SCOPES` variable of `wrangler.jsonc`.
- Shops with `marketDrivenShipping` keep merchant shipping in Markets. Read it only through `Market.delivery.shipping`; never read or fall back to legacy delivery profiles for such shops, and never call `marketCreate`/`marketUpdate`.
- Shopify's market-driven shipping compatibility is a self-attestation by the app owner, not configuration. Keep the status in the README's “Market-driven shipping compatibility” section current, update its supported subset with the mapper, and follow the release checklist. Never switch a store back to legacy shipping to hide Shopify's compatibility warning.
- If you change authentication behavior, keep `authPathPrefix = "/auth"` and ensure the redirect URLs still include the callback route.
- Prefer Shopify-provided install context such as `shop` and `host` query parameters. Treat manual `myshopify.com` entry as a fallback only.
- Preserve the post-install redirect from the auth callback flow to `/success` unless the onboarding flow changes deliberately.

## Public page requirements

- Keep the public routes `/`, `/auth/login`, and `/success` polished and review-friendly.
- Keep visible links to:
  - `https://aura-historia.com`
  - `https://aura-historia.com/privacy`
  - `https://aura-historia.com/imprint`
  - `https://aura-historia.com/terms-and-conditions`
- Keep the direct contact email `contact@aura-historia.com` visibly present on public pages.

## Design rules

- When changing UI, follow the Aura Historia design direction from `.agent/rules/design-guidelines.md`.
- Favor the mahogany/parchment/gold palette, editorial spacing, Newsreader-style headline treatment, and tonal separation instead of hard divider lines.
- Avoid turning the public pages into generic SaaS dashboards.

## Preferred implementation style

- Prefer configuration changes over new runtime code when possible.
- Prefer small React Router loaders/actions over new abstractions.
- Prefer server-side logic and static UI over client-side state.
- Add new runtime dependencies only when they are clearly necessary.

## Tooling rules

- Use Biome for linting.
- Keep package and CI Node versions aligned with `package.json` engines (`>=22.18`).
- Keep `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build` passing after meaningful changes.
- Keep the GitHub Actions CI workflow current when changing project scripts or quality checks.

## Testing expectations

- Add or update tests when changing login validation, Shopify app configuration, public routes, package scripts, or CI-sensitive tooling.
- Prefer focused unit tests and config-guard tests over large test harnesses.
