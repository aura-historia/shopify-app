# Aura Historia Partner Connect

A minimal public Shopify app that forwards merchant product lifecycle events to Aura Historia over Amazon EventBridge.

## What this app does

- Authenticates merchants and installs as an embedded Shopify app.
- Subscribes to `products/create`, `products/update`, and `products/delete`.
- Subscribes to the mandatory Shopify App Store compliance topics:
  - `customers/data_request`
  - `customers/redact`
  - `shop/redact`
- Handles `app/uninstalled` in-app so stored Shopify sessions are cleaned up.
- Redirects merchants to `/success` after Shopify approves installation.
- Keeps all AWS EventBridge consumers out of this repository.

## Install flow

This app is listed publicly, so the preferred install flow is the Shopify App Store or a Shopify admin launch.

In that flow, Shopify provides store context in the query string, including `shop` and `host`, and the app uses that context automatically. Merchants usually should **not** need to type their `myshopify.com` domain manually.

Manual shop-domain entry still exists, but only as a fallback for opening the app URL directly outside Shopify.

## Webhook delivery

| Topic(s) | Delivery target |
| --- | --- |
| `products/create`, `products/update`, `products/delete` | Aura Historia AWS EventBridge partner source |
| `customers/data_request`, `customers/redact`, `shop/redact` | Aura Historia AWS EventBridge partner source |
| `app/uninstalled` | `https://shopify.aura-historia.com/webhooks/app/uninstalled` handled by `app/routes/webhooks.app.uninstalled.tsx` |

## Public review surfaces

The public routes `/`, `/auth/login`, and `/success` all expose:

- a link to `https://aura-historia.com`
- a link to `https://aura-historia.com/privacy`
- a link to `https://aura-historia.com/imprint`
- a link to `https://aura-historia.com/terms-and-conditions`
- the direct contact email `contact@aura-historia.com`

The install-success route lives at `/success`, for example `https://shopify.aura-historia.com/success` when the app is hosted on that domain.

## Repository design

This repository intentionally stays small:

- React Router handles install/auth, the embedded app shell, and the public success page.
- Prisma stores Shopify sessions using SQLite by default.
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

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Prepare the local Prisma database:

   ```bash
   npm run setup
   ```

3. Start the preferred localhost development flow:

   ```bash
   npm run dev
   ```

   This runs `shopify app dev --use-localhost`.

4. If you need Shopify to directly invoke the app during development, use tunnel mode instead:

   ```bash
   npm run dev:tunnel
   ```

### Localhost mode caveat

Shopify localhost mode does not support features that directly call your machine, including webhooks. To keep `shopify app dev --use-localhost` working, the `app/uninstalled` webhook stays pinned to the deployed app URL instead of a relative local path.

That means:

- Product webhooks still go to AWS EventBridge.
- Compliance webhooks still go to AWS EventBridge.
- `app/uninstalled` cleanup remains implemented in this repo, but it is not locally exercised through localhost mode.
- Local SQLite session rows can remain stale after uninstall or reinstall testing in localhost mode because the uninstall webhook does not hit your machine.
- Use `npm run dev:tunnel` when you need to test direct webhook delivery into the app itself.

## Runtime requirements

Use Node.js `20.19.x` or newer in the supported `20` line, or Node.js `22.12.x` or newer.

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
- Confirm your Partner Dashboard listing includes a privacy policy URL.
- Confirm the configured redirect URLs include the app auth callback URLs used by this app.
- Confirm the public routes still expose privacy, imprint, terms, and `contact@aura-historia.com`.
