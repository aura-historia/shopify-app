# Aura Historia Partner Connect

A minimal public Shopify sales channel app that publishes merchant products to Aura Historia and forwards product lifecycle events over Amazon EventBridge.

## What this app does

- Authenticates merchants and installs as an embedded Shopify sales channel app.
- Declares a `channel_config` extension so Shopify registers Aura Historia as a sales channel.
- Keeps the Aura Historia discovery catalog in sync through `products/create`, `products/update`, and `products/delete`.
- Subscribes to the mandatory Shopify App Store compliance topics:
  - `customers/data_request`
  - `customers/redact`
  - `shop/redact`
- Handles `app/uninstalled` in-app so stored Shopify sessions, Aura Historia connection credentials, and pending backfill context are cleaned up.
- Returns merchants to the Shopify Admin app UI after Shopify approves installation.
- Starts Aura Historia OAuth only after the merchant clicks the embedded app's connection action and stores the returned partner shop ID plus bearer access token for the shop.
- Queues the existing backfill after Aura Historia OAuth succeeds.
- Directs shoppers who discover products on Aura Historia back to the merchant's Shopify store for checkout.
- Keeps all AWS EventBridge consumers out of this repository.

## Install flow

This app is listed publicly, so the preferred install flow is the Shopify App Store or a Shopify admin launch.

In that flow, Shopify provides store context in the query string, including `shop` and `host`, and the app uses that context automatically. Merchants do **not** need to enter an Aura Historia shop ID or API key manually.

After Shopify approves installation, the app now:

1. redirects the merchant back to the Shopify Admin app UI
2. shows the embedded merchant UI with a clear Aura Historia connection action
3. starts Aura Historia OAuth only when the merchant clicks that connection action
4. sends `requires_partner_shop_id=true`
5. encodes the Shopify store name into the base64 `state` payload
6. receives the OAuth callback at `https://partner-connect.aura-historia.com/oauth/callback`
7. exchanges the authorization `code` for an Aura Historia bearer access token
8. stores the returned `partner_shop_id` and access token for the Shopify shop
9. queues the existing initial backfill and redirects the merchant back to the embedded Shopify admin app

If the app URL is opened without Shopify-provided store context, the public pages explain that installation must start from a Shopify-owned surface instead of collecting a shop domain manually.

## Sales channel configuration

Aura Historia is configured as a traffic-driving discovery channel: shoppers discover products on Aura Historia, then continue checkout in the merchant's Shopify store. The channel spec therefore keeps `merchantOfRecord = "merchant"` and `expectsOnlineStoreParity = true`.

The channel specification covers every concrete Shopify country/region code and every language currently accepted by the generated Aura Historia backend API `LanguageData` type. Country feed currencies are always selected from the generated backend `CurrencyData` union (`EUR`, `GBP`, `USD`, `AUD`, `CAD`, `NZD`, `CNY`, `BRL`, `PLN`, `TRY`, `JPY`, `CZK`, `RUB`, `AED`, `SAR`, `HKD`, `SGD`, `CHF`); countries whose local currency is not accepted by the backend use a supported fallback currency so Shopify can apply feed currency conversion.

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

- React Router handles install/auth, the embedded sales channel app shell, and the public success page.
- The Shopify channel config extension declares the Aura Historia sales channel capabilities.
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
