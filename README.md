# Aura Historia Partner Connect

A minimal public Shopify app that forwards merchant product lifecycle events to Aura Historia over Amazon EventBridge.

## What this app does

- Authenticates merchants and installs as an embedded Shopify app.
- Subscribes to `products/create`, `products/update`, and `products/delete`.
- Subscribes to the mandatory Shopify App Store compliance topics:
  - `customers/data_request`
  - `customers/redact`
  - `shop/redact`
- Handles `app/uninstalled` in-app so stored Shopify sessions, Aura Historia connection credentials, and pending backfill context are cleaned up.
- Starts Aura Historia OAuth automatically after Shopify approves installation.
- Stores the Aura Historia partner shop ID plus bearer access token for the shop and queues the existing backfill.
- Keeps all AWS EventBridge consumers out of this repository.

## Install flow

This app is listed publicly, so the preferred install flow is the Shopify App Store or a Shopify admin launch.

In that flow, Shopify provides store context in the query string, including `shop` and `host`, and the app uses that context automatically. Merchants do **not** need to enter an Aura Historia shop ID or API key manually.

After Shopify approves installation, the app now:

1. redirects the merchant to the Aura Historia OAuth authorization endpoint
2. sends `requires_partner_shop_id=true`
3. encodes the Shopify store name into the base64 `state` payload
4. receives the OAuth callback at `https://partner-connect.aura-historia.com/oauth/callback`
5. exchanges the authorization `code` for an Aura Historia bearer access token
6. stores the returned `partner_shop_id` and access token for the Shopify shop
7. queues the existing initial backfill and redirects the merchant back to the embedded Shopify admin app

If the app URL is opened without Shopify-provided store context, the public pages explain that installation must start from a Shopify-owned surface instead of collecting a shop domain manually.

## Webhook delivery

| Topic(s) | Delivery target |
| --- | --- |
| `products/create`, `products/update`, `products/delete` | Aura Historia AWS EventBridge partner source |
| `customers/data_request`, `customers/redact`, `shop/redact` | Aura Historia AWS EventBridge partner source |
| `app/uninstalled` | `https://partner-connect.aura-historia.com/webhooks/app/uninstalled` handled by `app/routes/webhooks.app.uninstalled.tsx` |
| `bulk_operations/finish` | `https://partner-connect.aura-historia.com/webhooks/bulk-operations/finish` handled by `app/routes/webhooks.bulk-operations.finish.tsx` for initial backfill completion |

## Public review surfaces

The public routes `/`, `/auth/login`, and `/success` all expose:

- a link to `https://aura-historia.com`
- a link to `https://aura-historia.com/privacy`
- a link to `https://aura-historia.com/imprint`
- a link to `https://aura-historia.com/terms-and-conditions`
- the direct contact email `contact@aura-historia.com`

The install-success route lives at `/success`, for example `https://partner-connect.aura-historia.com/success` when the app is hosted on that domain.

## Repository design

This repository intentionally stays small:

- React Router handles install/auth, the embedded app shell, and the public success page.
- Cloudflare KV stores Shopify sessions and Aura Historia connection metadata.
- There is no sample GraphQL mutation logic, demo navigation, or placeholder business logic.
- AWS routing, rules, and consumers live in another repository.

## Stage-dependent Shopify configuration

App-specific webhook subscriptions live in `shopify.app*.toml`, not `shopify.web.toml`.

This repository keeps two app configurations:

- `shopify.app.toml`: default local and stage-oriented config using the `...aura-historia-backend-dev` EventBridge partner source
- `shopify.app.prod.toml`: production config using the `...aura-historia-backend-prod` EventBridge partner source

Helpful commands:

```bash
npm run config:use:prod
npm run deploy:prod
```

If you stay on the default config, use:

```bash
npm run deploy
```

Tagged releases such as `1.2.3` trigger `.github/workflows/deploy.yml`, which:

- runs `npm ci`, `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build`
- deploys the web app to Cloudflare Workers
- deploys and then releases the Shopify app with the `prod` config using the tag as the app version

Configure these GitHub Actions secrets before using the workflow:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SHOPIFY_APP_AUTOMATION_TOKEN`

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Configure the Aura Historia OAuth client in your local environment.

   The app reads these runtime variables:

   - `AURA_HISTORIA_OAUTH_CLIENT_ID`
   - `AURA_HISTORIA_OAUTH_CLIENT_SECRET`
   - `AURA_HISTORIA_OAUTH_ENV` (`dev` uses `https://stage.aura-historia.com/oauth/authorize`, `prod` uses `https://aura-historia.com/oauth/authorize`)

   Optional overrides:

   - `AURA_HISTORIA_API_BASE_URL`
   - `AURA_HISTORIA_OAUTH_AUTHORIZE_URL`
   - `AURA_HISTORIA_OAUTH_TOKEN_URL`
   - `AURA_HISTORIA_OAUTH_REDIRECT_URI`
   - `AURA_HISTORIA_OAUTH_SCOPE`

3. Start the preferred localhost development flow:

   ```bash
   npm run dev
   ```

   This runs `shopify app dev --use-localhost`.

4. If you need Shopify to directly invoke the app during development, use tunnel mode instead:

   ```bash
   npm run dev:tunnel
   ```

   This uses `shopify.app.tunnel.toml`, where the `bulk_operations/finish`
   webhook is relative so Shopify CLI can point it at the active tunnel URL.

### Localhost mode caveat

Shopify localhost mode does not support features that directly call your machine, including webhooks. To keep `shopify app dev --use-localhost` working, the `app/uninstalled` webhook stays pinned to the deployed app URL instead of a relative local path.

That means:

- Product webhooks still go to AWS EventBridge.
- Compliance webhooks still go to AWS EventBridge.
- `app/uninstalled` cleanup remains implemented in this repo, but it is not locally exercised through localhost mode.
- Initial backfill submission can start in localhost mode, but the
  `bulk_operations/finish` callback is not locally delivered there.
- Local SQLite session rows can remain stale after uninstall or reinstall testing
  in localhost mode because the uninstall webhook does not hit your machine.
- Use `npm run dev:tunnel` when you need to test direct webhook delivery into the
  app itself, including initial backfill completion.

## Runtime requirements

Use Node.js `20.19.x` or newer in the supported `20` line, or Node.js `22.12.x` or newer in current/future lines (`>=20.19 <22 || >=22.12`).

## Quality checks

Run these before opening a PR:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

`npm run lint` uses [Biome](https://biomejs.dev/) for linting and formatting checks.

## Continuous integration

GitHub Actions runs the following checks on pushes and pull requests:

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`

The workflow lives at `.github/workflows/ci.yml`.

## Public app checklist

Before submitting the app for Shopify App Store review:

- Confirm the EventBridge ARN is correct for the target AWS account and region.
- Confirm the mandatory compliance topics remain subscribed.
- Confirm the app is listed as free, or implement Shopify App Pricing / Billing API before charging merchants.
- Confirm the Partner Dashboard and App Store listing name match `Aura Historia Partner Connect`.
- Confirm your Partner Dashboard listing includes a privacy policy URL.
- Confirm the configured redirect URLs include the Shopify auth callback URL used by this app.
- Confirm the Aura Historia OAuth client allows `https://partner-connect.aura-historia.com/oauth/callback` as a redirect URI.
- Confirm the production Worker has `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `AURA_HISTORIA_OAUTH_CLIENT_ID`, and `AURA_HISTORIA_OAUTH_CLIENT_SECRET` configured as secrets.
- Confirm the public routes still expose privacy, imprint, terms, and `contact@aura-historia.com`.
- Provide Shopify App Review with current test credentials for Aura Historia OAuth, a development store, and an English screencast showing install, OAuth approval, embedded status, disconnect, uninstall/reinstall, and expected product-sync behavior.
- Keep the emergency developer contact current in the Partner Dashboard.
