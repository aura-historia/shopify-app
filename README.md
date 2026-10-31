<h1 align="center">Aura Historia for Shopify</h1>

<p align="center">
  A quiet, reliable bridge between Shopify product catalogs and the Aura Historia sales channel.
</p>

<p align="center">
  <a href="https://github.com/aura-historia/shopify-app/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/aura-historia/shopify-app/ci.yml?branch=main&label=checks&style=flat-square" alt="Continuous integration" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-4a1520?style=flat-square" alt="MIT License" /></a>
  <a href="./package.json"><img src="https://img.shields.io/badge/node-%E2%89%A522.18-170d0e?style=flat-square" alt="Node.js 22.18 or later" /></a>
  <a href="https://shopify.dev/docs/api/usage/versioning"><img src="https://img.shields.io/badge/Shopify_API-2026--10-7a5c30?style=flat-square" alt="Shopify API version 2026-10" /></a>
</p>

<p align="center">
  <a href="#architecture">Architecture</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#local-development">Local development</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#quality-checks">Quality checks</a>&nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="#deployment">Deployment</a>
</p>

---

## In brief

The **Aura Historia** app is a public, embedded Shopify sales-channel app. It lets approved merchants connect their shops to Aura Historia, makes product discovery possible on Aura Historia, and returns shoppers to the merchant’s Shopify store for checkout.

The app is free to install and use, with no charges or commissions. Shopify has already approved the app. Making it publicly visible in the Shopify App Store is a separate action planned for later.

The app intentionally owns only the integration edge: authentication, merchant connection, initial catalog backfill, session storage, advertised shipping imports, and uninstall cleanup. Amazon EventBridge routing and downstream catalog consumers are maintained separately.

| Shopify | Aura Historia |
| --- | --- |
| Merchant installs from Shopify App Store or Admin | Merchant authorizes Aura Historia from the embedded app |
| Shopify supplies trusted shop context and OAuth approval | Connection metadata is stored in Cloudflare KV |
| Product listing events for the Aura Historia channel are delivered to the configured EventBridge partner source | Products published to the channel are published for discovery |
| Shopper continues to the merchant’s Shopify storefront | No checkout or merchant-of-record responsibility moves to Aura Historia |

## Architecture

```mermaid
flowchart LR
    M[Merchant in Shopify Admin] --> I[Embedded Aura Historia app]
    I --> S[Shopify OAuth]
    I --> O[Aura Historia OAuth]
    O --> K[Cloudflare KV]
    S --> K
    P[Shopify channel product listing events] --> E[Amazon EventBridge partner source]
    E --> A[Aura Historia catalog consumers]
    I --> B[Initial catalog backfill]
    B --> A
    U[App uninstall webhook] --> C[Session and connection cleanup]
    C --> K
    SP[Shopify profile, market and scope events] --> H[HTTPS shipping receiver]
    H --> D[Per-shop Durable Object]
    D --> G[Shopify Admin API acquisition]
    G --> D
    D --> SH[Typed Aura shipping API]
```

### What lives here

- React Router application and embedded Shopify app shell
- Shopify authentication, Aura Historia OAuth, and connection state
- Cloudflare Worker deployment and Cloudflare KV session storage
- Channel-filtered catalog import orchestration in a resumable per-shop Durable Object
- Server-side shipping acquisition, typed mapping and resumable publication
- A per-shop Durable Object coordinating offline Shopify access and shipping jobs
- Shopify sales-channel configuration in `extensions/channel-config` and the explicit channel connection in `app/channel.server.ts`
- Uninstall cleanup at `app/routes/webhooks.app.uninstalled.tsx`

### What does not

- EventBridge infrastructure, rules, or consumers
- A checkout experience or storefront
- Demo pages, sample mutations, or placeholder app logic

## Event delivery

| Topic | Destination | Purpose |
| --- | --- | --- |
| `product_listings/add`, `product_listings/update`, `product_listings/remove` | Aura Historia Amazon EventBridge partner source | Keep products published to the Aura Historia channel current; removal from the channel withdraws them |
| `customers/data_request`, `customers/redact`, `shop/redact` | Aura Historia Amazon EventBridge partner source | Required public-app privacy and compliance handling |
| `profiles/create`, `profiles/update`, `profiles/delete` | This app’s HTTPS `/webhooks/shipping` receiver | Durably schedule current shipping acquisition |
| `markets/create`, `markets/update`, `markets/delete` | This app’s HTTPS `/webhooks/shipping` receiver | Durably schedule current acquisition of [market-driven shipping](#market-driven-shipping) |
| `app/scopes_update` | This app’s HTTPS `/webhooks/shipping` receiver | Recheck current shipping access, import once updated access is approved, and withdraw owned assertions on permission loss |
| `app/uninstalled` | This app’s deployed HTTPS endpoint | Stop shipping, admit owned cleanup, then remove Shopify sessions and connection data |
| `bulk_operations/finish` | This app’s deployed HTTPS endpoint | Admit the channel-filtered catalog export to the resumable catalog importer |

The required public-app compliance subscriptions and product listing subscriptions are declared in `shopify.app.toml` and `shopify.app.prod.toml`.

## Catalog synchronization

Merchants choose which products appear on Aura Historia by publishing them to the Aura Historia sales channel. The channel exists once the merchant connects an Aura Historia account (see [Channel connection](#channel-connection)). That selection governs every catalog path:

- **Ongoing changes** use Shopify's own-channel `product_listings/add`, `product_listings/update` and `product_listings/remove` topics, which Shopify scopes to this app's channel. Publishing adds or restores a product, and edits and stock changes arrive as updates. Removal from the channel withdraws the listing, even if the product stays active elsewhere. Out-of-stock products remain listed with their inventory availability.
- **Initial import, “Import catalog again” and retries** share one bulk export. It resolves the publication of the installation's channel connection and reads `publishedOnPublication(publicationId: …)` for every product. An `ACTIVE` product is upserted only when that membership is explicitly `true`, and withdrawn when it is `false`. A missing value is unknown: the product is reported as a failure and the import is not complete. `DRAFT`/`ARCHIVED` products are withdrawn and other statuses are ignored, as before. Source listing IDs remain Shopify numeric product IDs.
- **Missing access, channel or publication.** Before exporting, the app verifies that `read_product_listings` and `read_publications` (or their write scopes) were actually granted to the installation, using a separate `accessScopes` query. Without `read_publications`, Shopify denies the channel's publication, and its access-scope reference places products' publication fields such as `publishedOnPublication` under that scope too. It also verifies that the channel connection is bound to the connected listing source and that its publication exists. If any check fails or a read fails, no export runs. A missing grant is reported as `MISSING_SCOPE` with a link to approve the app's permissions in Shopify; other failures are shown as retryable, and failed publication reads log Shopify's error text. There is never a fallback to all active products, `onlineStoreUrl`, Online Store publishing or an aggregate count. Every processing step checks the scope, connection and publication again before writing; a rebound connection or changed publication discards the snapshot.
- **Channel setup window.** Right after `channelCreate`, Shopify may not return the new connection's app catalog or its publication yet: in production QA, fresh connections' initial imports found no catalog listing the connection, while the embedded app read the selection seconds later ([#405](https://github.com/aura-historia/shopify-app/issues/405)). Delayed visibility is the likely, unconfirmed cause. An import whose bound connection has no publication yet, because no app catalog lists the connection or its catalog returns a `null` publication, therefore waits instead of failing: the importer checks again after 2 seconds, doubling the wait up to a minute, for at most 10 minutes after it began waiting, and exports the channel's membership as soon as the publication is readable. A read that fails during the wait is retried within the same window. Only when the window closes is the import reported as `MISSING_PUBLICATION`, or as a read failure if the last read failed. Nothing else starts a wait: missing access, a missing or foreign connection, and failed, denied or ambiguous publication reads are reported at once, as before. Missing access and a missing or foreign connection also end a wait at once, and a failed export submission is reported as it would be at the start. While the import waits, the embedded app shows the channel as being prepared and the import as queued; a page that cannot read the selection says so instead.

### Channel connection

The app is a channel-config-extension sales channel, so it manages explicit channel connections with `channelCreate`/`channelUpdate` instead of Shopify's legacy install-time channel. `create_legacy_channel_on_app_install` stays `false`: installing the app creates no channel and no publication.

- **Setup.** The connection is created after the merchant authorizes Aura Historia and Aura has accepted the listing source's ingestion configuration with that token, immediately before the initial import. Every “Import catalog again” repeats the same idempotent step, so it also repairs a missing or failed setup. The initial import waits for the new connection's publication within the [channel setup window](#catalog-synchronization), so a fresh connection needs no manual retry while Shopify does not return the new publication yet.
- **Identity.** One connection per installation with the fixed handle `aura-historia`, the `aura-historia` specification, `accountId` set to the authorized listing source ID and `accountName` “Aura Historia”. The importer only uses a connection bound to the connected listing source.
- **Coverage.** Any store can connect, whatever its market coverage: worldwide, a few countries or a single market. The `aura-historia` specification declares every Shopify country with Aura's languages and sets `expectsOnlineStoreParity = false`. Shopify creates product feeds for the store's region markets that cover a declared country, and binds the connection to the store's defaults when none does. The app never creates, changes or removes markets. With parity required, Shopify refused `channelCreate` unless every declared country had a matching region market, so a store with a single United States market could not connect ([#378](https://github.com/aura-historia/shopify-app/issues/378)). One parity specification per country would need market access and a connection and publication per market country. Parity itself only adds Markets warnings about channel-specific prices, which Aura does not use. Shoppers still check out in the merchant's store (`merchantOfRecord = "merchant"`). The import sends each product's own price in the store currency and reads no product feed, so price or currency settings of a channel market for Aura are not applied. The store currency must still be one Aura supports.
- **Retry, reconnect and concurrency.** A retried callback or import finds the connection by handle and changes nothing. Connecting another listing source rebinds the same connection with `channelUpdate`, so the merchant's product selection is kept. If a concurrent request created the handle first, the existing connection is adopted. No second connection is created.
- **Failure.** A missing `read_product_listings` grant is reported as missing access before any channel write. Setup needs no `read_publications`, so an installation that has not approved it yet still gets its connection and listing events. A Shopify `userErrors` refusal is reported as `CHANNEL_REJECTED`, with Shopify's message in the Worker log, and failed reads as a retryable read failure. The Aura connection and shipping import stay in place; the catalog shows the failure until “Import catalog again” succeeds. A refused or failed setup is never reported as an importable channel.
- **Disconnect and uninstall.** Disconnecting keeps the connection and its product selection for a later reconnect. After uninstall the app can no longer call Shopify. On reinstall, the next connection reuses a surviving connection or creates one.
- **Publication.** `currentAppInstallation.publication` is deprecated in 2026-10 and does not identify an explicit connection; it was empty on the QA installation. `AppCatalog.publication` is a publication field: without `read_publications` Shopify answers `ACCESS_DENIED` (“Access denied for publication field.”), even for the app's own catalog ([#392](https://github.com/aura-historia/shopify-app/issues/392)). The app first scans the app catalogs for identity and channels only (`catalogs(type: APP)`, at most 20 pages of 25), which every app catalog exposes, to find the one catalog that lists its connection. It then reads `publication` on that catalog alone with `catalog(id:)`, which also confirms the catalog still lists the connection. A `null` publication there, like a catalog scan that finds no catalog listing the connection, is a missing publication; any other unexpected answer is a failed read. Other apps' catalogs never fail the lookup. The bulk editor link and membership reads use that publication; the channel count is the connection's `productsCount` for active products.
- **Product feeds.** The specification keeps `productFeedManagement = "automatic"`, so Shopify creates the connection's product feeds. The app subscribes to no `product_feeds/*` topic: catalog sync stays on the publication and the `product_listings/*` topics above.
- **Permission recovery.** Fresh installations request all required scopes, including `read_publications`. If required access is missing, imports stop with `MISSING_SCOPE` before any export, and the embedded app shows **Review app permissions in Shopify**. Once the merchant approves, `app/scopes_update` resumes an import that stopped for missing access; “Import catalog again” also works. Release the Shopify configuration with the Worker so new installations request the scopes it needs.

### Withdrawals

Imports withdraw only products that are in the Shopify export and known to be ineligible: `DRAFT`/`ARCHIVED` products and `ACTIVE` products not published to the channel, each by its own Shopify product ID. Withdrawing a product that was never imported is a no-op downstream. Aura listings are never read or withdrawn because they are absent from the export.

An import is reported complete only when Shopify reported `COMPLETED` without an error code, the whole export was read, the number of product rows equals the operation's `rootObjectCount`, and every membership read was explicit. Otherwise the import is reported as failed with a retry.

### Resumable processing

`bulk_operations/finish` only admits the export to the per-shop `CatalogImporter` Durable Object (`CATALOG_IMPORTER` binding, `catalog-importer-v1` SQLite migration). The webhook returns 503 if admission fails, so Shopify retries. Duplicate deliveries do not restart an admitted import, and deliveries for an export that is no longer the current import admit nothing.

Each alarm streams the export from its checkpoint and submits batches for up to 20 seconds; the budget starts once the export responds, and every alarm imports at least one segment, so a slow download cannot starve submission. Failed Shopify reads and downloads, including an unreadable publication, are retried with exponential backoff, at most six times in a row, before the import is reported as failed with the progress made so far. A step that imported something before it failed starts its retries afresh. Only a confirmed missing scope, missing or rebound channel connection, missing publication or replaced publication ends an import immediately.

#### Streamed exports

The export is submitted with `groupObjects: true`, so Shopify lists each product's images and variants directly after it; without it, Shopify does not guarantee that order. The importer reads the JSONL line by line from a stream, splitting on bytes, so a line or a multibyte character split across network chunks is joined before it is decoded and every offset is a UTF-8 byte offset.

- **Segments.** The export is consumed in segments of consecutive products. A segment ends right before a product line once it holds 100 products or 1 MiB of retained product and image lines, so it never separates a product from its images or variants. Variant lines are read for the first variant's price only and never count towards a segment.
- **Batches and keys.** Segment *n* yields at most one upsert and one withdrawal batch, keyed `shopify-backfill-<operation>-put-<n>` and `shopify-backfill-<operation>-delete-<n>`. Segment boundaries depend only on the immutable export, so retries and restarts rebuild the same batches under the same keys. Each job records the version of these segment rules (`EXPORT_PLAN_VERSION`); a job planned under other rules, for example before a deployment that changed them, is never resumed and ends as `INCOMPLETE_EXPORT`.
- **Checkpoints.** The job stores the byte offset and index of the next segment, the batches of that segment already sent, and the counts so far. It is checkpointed before every segment's batches (which also fences them against a retired generation) and after every batch. Every download requests the byte range from the checkpoint's offset, so a resumed step neither downloads nor parses the consumed part again; a server that ignores the range is skipped forward to the offset. A batch whose checkpoint was lost is resent with its original key and content.
- **Truthful outcomes.** The export's size is Shopify's `fileSize`, or else the size the download reports: the total of its `Content-Range`, or the `Content-Length` of an unencoded full response. A download that ends before that size, stalls for 20 seconds, or still runs 40 seconds after the step's budget is retried from the checkpoint. An export whose size is unknown is imported but never reported complete. A line that is not valid UTF-8 or JSON, or a child that does not directly follow its product, ends the import as `INCOMPLETE_EXPORT` before the segment being read is sent. Batches already admitted stay admitted, nothing is withdrawn for products the import did not read, and a partial import is never reported complete.

#### Supported catalog, memory and lifetime

These limits are enforced in code, not measured under live load:

| Limit | Value | Enforcement |
| --- | --- | --- |
| Products in the export | 100,000 | Shopify's `rootObjectCount` before any download, then while streaming |
| Export file | 1 GiB (UTF-8 bytes of all product, image and variant lines) | Shopify's `fileSize` before any download, then while streaming |
| One step's download | Its 20-second budget plus 40 seconds; 20 seconds per chunk | While streaming |
| One JSONL line | 64 KiB | While streaming |
| One product with its images | 1 MiB | While streaming |
| Retained per step | One segment: at most 100 products and about 2 MiB of product and image lines | By construction |
| Shopify export | 24 hours from submission; a completion is admitted until one check (five minutes) later | Importer alarm and completion webhook |
| Import | 24 hours from admission | Importer alarm |
| Channel publication wait | 10 minutes after the import began waiting, checked after 2 seconds and then twice as long each time, at most a minute apart | Importer alarm |

The export lists every product of the store, not only those published to Aura, so the product limit applies to the whole catalog. A larger export ends as `EXPORT_TOO_LARGE`: before anything is downloaded when Shopify reports its size, otherwise when streaming passes a limit, after the segments before it were submitted. The merchant is asked to contact support.

While Shopify exports, the importer checks the bulk operation every five minutes and once more when the window closes. A completed export is admitted even if its webhook was lost, and a failed, canceled or missing one ends the import as a read failure. Only a check that reads the export as running keeps the queued status current: while checks fail, the status reads as failed after an hour, and checking continues. An export that has not completed by the last check ends as `EXPORT_EXPIRED` and is cancelled with `bulkOperationCancel`, so it does not hold Shopify's bulk query capacity; a completion webhook is admitted until one check after the window. An import still running 24 hours after admission ends as `IMPORT_EXPIRED` with its progress. Both are retried with “Import catalog again”. Shopify itself allows ten days per export, but the import does not keep credentials that long.

The generation's KV context, which carries the Aura token, is stored with a TTL of 49 hours: both windows plus an hour, which also covers the five minutes of late admission. An active import therefore never loses it, and it is never renewed. It is released as soon as the import finishes, fails, expires or is retired by a newer import, disconnect, uninstall or connection replacement; the TTL only bounds a copy whose release failed. The job itself holds no credentials. OAuth exchange, source configuration, the export's response and each of its chunks, and each catalog batch request have a 20-second timeout.

Offline tests cover generated exports of up to 2,500 products with multibyte text read in chunks down to one byte, segment byte bounds, the line, product and export limits, malformed, partial and ungrouped lines, interrupted, cut-off, stalled and unsized downloads, resumes with byte ranges and in the middle of a segment, a server that ignores ranges, and exports and imports that run past the former one-hour limit or expire, with a context store that expires keys on the test clock. No live load test backs these limits.

### Import generations

The `CatalogImporter` is the authority over the shop's import generations. Every
import attempt (the initial import, “Import catalog again”, or a resume after approved
access) begins a new generation before it sets up the channel or starts an export,
which retires the previous one. Disconnect, uninstall and connection replacement retire
the current generation too:

- **Ordering with the connection.** An import begins through the shop coordinator, in
  the same serialized order as disconnect and replacement, and never for a stopped or
  replaced connection. A disconnect or uninstall stops the importer first; if that
  fails, nothing is stopped and the disconnect or webhook delivery can be retried. A
  replacement stops it once the new connection record is stored, so a failed
  replacement leaves the current import running. If that stop fails, it stays pending
  until the coordinator's next alarm or the new connection's import retires the old
  generation. A request that read the connection before it was disconnected or replaced
  cannot begin an import afterwards, and overlapping OAuth callbacks leave the import
  with the connection that ends up stored.
- **One owner per write.** Only the current generation can queue its export, be
  admitted by the completion webhook, schedule the alarm, submit a batch or record
  progress. Each of these writes checks the generation in the same Durable Object
  transaction, and the job, its progress and its alarm are retired together. Progress
  lives in the importer, not in KV, so an older import cannot overwrite a newer
  status.
- **Credentials per generation.** The job stores no credentials. Each generation's
  Aura token and export metadata are stored in their own KV context
  (`aura-historia:backfill:<shop>:<generation>`), written before the job that uses them
  and released when the generation finishes or is retired. Its TTL covers the export and
  import windows (see [Supported catalog, memory and lifetime](#supported-catalog-memory-and-lifetime)).
  Releasing an older context never touches a newer one. A context whose generation was
  retired while it was being stored is released at once.
- **Requests in flight.** Every batch, and every resend of an unconfirmed batch, is
  preceded by a successful check of the generation. Once a stop or replacement is
  acknowledged, no batch is sent for the old generation. A request that was already in
  flight completes or times out, and its result is discarded. A batch Aura admitted
  stays admitted; it is not withdrawn. Batch idempotency keys are unchanged. An attempt
  retired while it was still preparing may finish its channel setup and Shopify export;
  that export is never admitted.
- **No revival.** Delayed or duplicate completion webhooks, export checks, alarm
  retries and a new instance after eviction find no job of a retired generation and
  change nothing. Jobs from before import generations or streamed exports are never
  admitted, and an admitted one ends as `INCOMPLETE_EXPORT`: its batches were planned
  differently. A missing context of the current generation is retried like a failed
  read and then reported as failed.
- **Awaited publications.** An attempt whose channel publication Shopify has not
  returned yet stores its credentials in a setup context of its own
  (`aura-historia:backfill-setup:<shop>:<generation>`, kept for the window plus an
  hour), so the export's context is never read before it is written. The importer
  records only the wait's generation, shop, listing source, start and number of
  checks. Its alarm checks the publication again; only the current generation's
  check can submit the export, queue it or record the outcome, each checked in the
  same transaction as above. Beginning and stopping an import retire the wait with
  its generation, and a failure ends it, so “Import catalog again”, disconnect,
  uninstall and connection replacement end it, and the setup context is released
  whenever the wait ends. A wait retired during a check submits no export; an export
  submitted while it was retired is cancelled and never admitted. Reading the import
  status re-arms a wait whose alarm was lost.
- **Failed attempts.** An attempt that cannot export (missing access, channel or
  publication, or a failed submission) records its failure as the current status.
  Because it already retired the previous generation, an older import that was still
  running stops as well; importing again starts over.

### Ordering with live listing events

Bulk writes use the existing canonical asynchronous upsert and withdrawal endpoints without ordering metadata. They have no shared ordering guarantee with listing webhooks:

- An import that overlaps an unpublish can restore the removed product.
- An older withdrawal batch can withdraw a product that was republished later.

“Import catalog again” repairs such a state. Idempotency keys prevent duplicate application only; they do not order bulk writes against webhooks.

### Counts and status

- The channel count is Shopify's `productsCount` of active products published to the channel connection. It is not an import count.
- “Last import” reports the Shopify products checked, the eligible products submitted, the admitted withdrawals of unpublished or inactive products, and failures.
- Acceptance by Aura Historia means queue admission. Search visibility follows asynchronously and still applies product-status rules.
- Missing permissions, a missing or refused channel connection, a missing publication once its setup window closed, incomplete or malformed exports, oversized exports and expired exports or imports remain visible as failures with a retry. They are never shown as a successful zero-product import. While an import is processing, the counts cover the segments read so far.

### Rollout

This is a fresh release with no existing installations. Credential records require a connection ID, and shipping jobs use the current request format; no older app data or pending request formats are migrated. Cloudflare’s Durable Object migration declarations provision the SQLite namespaces and remain required for the configured deployment flow.

1. Deploy backend listing-event support ([aura-historia/backend#2573](https://github.com/aura-historia/backend/pull/2573)). Do not release this Shopify configuration earlier: without backend routing, live product sync does not work.
2. Deploy the Worker, which adds the `CatalogImporter` migration, and release the Shopify configuration.
3. Verify the following on a development store:
   - A fresh install creates no channel; connecting Aura Historia creates exactly one `aura-historia` connection bound to the listing source, and a retried connection or import creates no second one.
   - The initial import of a fresh install, and of a reinstall after uninstalling, reaches the channel-filtered export without “Import catalog again”, also when Shopify returns the new connection's publication only after the import began.
   - The connection is created, without changing any market, on a store with a single region market, on one with several markets in different currencies and languages, and on one with a worldwide market.
   - Products can be selected for the channel, and `product_listings/*` events arrive for that selection.
   - Selected and unselected products.
   - Publication-only removal and restoration.
   - Title, image, price and stock updates.
   - Draft, archive, delete and reactivation.
   - An import that overlaps a publication change, repaired by importing again.
   - A catalog of several hundred products imports across alarms, with ranged downloads of Shopify's grouped export.

## Local development

### Requirements

- [Node.js](https://nodejs.org/) **22.18 or later**
- A Shopify Partner account and app credentials
- A Cloudflare KV namespace for session storage
- Aura Historia OAuth client ID and secret (confidential client)

### Start the app

```bash
npm ci
npm run dev
```

The default command runs `shopify app dev --use-localhost`.

Create local runtime configuration for the Aura Historia OAuth client. The app requires:

```bash
# PLACEHOLDER: replace with the canonical oc_... ID registered in the stage backend.
AURA_HISTORIA_OAUTH_CLIENT_ID=oc_REPLACE_WITH_STAGE_OAUTH_CLIENT_ID
AURA_HISTORIA_OAUTH_CLIENT_SECRET=
AURA_HISTORIA_OAUTH_ENV=dev
```

Use `.dev.vars` for local Cloudflare binding overrides; shell variables do not override bindings in `wrangler.jsonc`. Production uses the registered client `oc_01m5vyyghjecx8c43drb05hh4n`; its secret is stored as `AURA_HISTORIA_OAUTH_CLIENT_SECRET` in Cloudflare, never in source. Both the client ID and secret are required (`client_secret_post` plus S256 PKCE). The stage and production OAuth clients must each allow `listing-sources:read listing-sources:write product-listings:read product-listings:write` and their respective Shopify callback redirect URI. OAuth refuses to start with a placeholder ID or missing secret. The backend development API base URL is `https://api.stage.aura-historia.com` (production: `https://api.aura-historia.com`). For the Shopify connection, request the Aura Historia OAuth scopes `listing-sources:read listing-sources:write product-listings:read product-listings:write` (separate from the Shopify access scopes below). Set `AURA_HISTORIA_API_BASE_URL` and `AURA_HISTORIA_OAUTH_SCOPE` to match the target backend and registered OAuth client:

```bash
AURA_HISTORIA_API_BASE_URL=https://api.stage.aura-historia.com
AURA_HISTORIA_OAUTH_AUTHORIZE_URL=
AURA_HISTORIA_OAUTH_TOKEN_URL=
AURA_HISTORIA_OAUTH_REDIRECT_URI=
AURA_HISTORIA_OAUTH_SCOPE=listing-sources:read listing-sources:write product-listings:read product-listings:write
```

> **Webhook testing:** Shopify localhost mode cannot call your machine directly. Product and compliance events continue to use EventBridge, while `app/uninstalled` remains pinned to the deployed HTTPS app URL. For direct local testing of the backfill completion webhook, use tunnel mode:
>
> ```bash
> npm run dev:tunnel
> ```

## Shopify configuration

The repository uses separate Shopify configuration files to keep stage-specific EventBridge destinations explicit:

| File | Use |
| --- | --- |
| `shopify.app.toml` | Default local/stage configuration using the development EventBridge partner source |
| `shopify.app.prod.toml` | Production configuration using the production EventBridge partner source |
| `shopify.app.tunnel.toml` | Development tunnel mode; exposes backfill completion and shipping receivers through the active tunnel |

The required Shopify scopes are `read_products`, `read_product_listings`, `read_publications`, `read_locales`, `read_shipping` and `read_markets`. `read_product_listings` is required by the channel connection and the own-channel listing topics. `read_publications` is required to read the channel's publication, which Shopify denies without it, and, per Shopify's access-scope reference, products' publication fields such as the `publishedOnPublication` membership of every catalog import. It needs no Shopify approval and grants no write access. `read_shipping` and `read_markets` must stay required: the profile and market webhook subscriptions are declared statically, and Shopify rejects static subscriptions whose scope is only optional. `read_markets` reads the shipping of [market-driven shops](#market-driven-shipping); the app never writes markets. The same list is mirrored in the `SCOPES` variable of `wrangler.jsonc`. Installation starts from Shopify-owned surfaces, which supply the trusted `shop` and `host` context—merchants are not asked to manually enter a shop domain.

## Advertised shipping imports

Initial Aura connection queues a shipping import independently of the catalog backfill.
The embedded app offers **Import shipping settings** (new acquisition or resume).
Installations approved before `read_shipping` or `read_markets` became required are
asked by Shopify to approve the updated access the next time the app is opened. Until
then shipping status reports the missing permission (`read_markets` only for
market-driven shops) and catalog sync continues; the resulting
`app/scopes_update` notification starts a new acquisition. Existing Aura connections
need reconnection with the additional `listing-sources:read` and `product-listings:read`
OAuth permissions. Register those permissions on both OAuth clients before rollout.

Shipping runs in app-owned Durable Object alarms without an open browser. The
`SHOP_COORDINATOR` binding and `shop-coordinator-v1` SQLite migration are required.
Catalog and shipping use its serialized offline GraphQL path, which delegates token
refresh to the existing Shopify SDK and KV sessions. The backend never calls this
worker, reads its sessions, or receives Shopify credentials.

`app/shipping/acquisition.server.ts`, `mapper.ts`, and `publisher.server.ts` are the
common S01/S02 implementation. Initial connection, **Import shipping settings**,
profile notifications and periodic reconciliation all use that acquisition/mapper/publisher.
Callbacks authenticate the bounded original body with Shopify, require an existing
offline installation and durable source binding, then commit a deduplicated hint
inbox. No provider read, token refresh or Aura publication runs in the callback.
The receiver returns 503 on failed durable admission, so Shopify retries.
Hints carry metadata only and never supply the Aura source identity or policy. Work is ordered by the current shop/source binding and an
increasing durable sequence. Concurrent requests coalesce into a subsequent read.
Conflicts trigger bounded reacquisition; pending uncertain writes retain their body,
request key, sequence and original acquisition time across worker restarts. Missing
catalog listings are retried independently without creating products. Partner-owned
assertions and explicit clears are protected by backend import ownership checks.
Reconciliation resolves other uncertain requests before replacing an acquisition.
An inbox hint received during a scan forces reacquisition before publication.
Already prepared requests resolve with their original keys, sequence and acquiredAt
before newer work; no old observation is rebased onto a current revision.
Publication stops retrying each record after eight failures; acquisition pauses after
eight consecutive failures on a page. Exhausted work remains saved for up to seven days,
subject to replacement by a new complete acquisition during periodic repair. **Import shipping settings**
resumes those exact pending requests before acquiring the latest settings. GraphQL
and Aura API calls have a 20-second timeout, and applied status requires a valid
committed response.

Reads are bounded to 50 records per connection page, 100 profiles or markets, 5,000 products,
4,000 requests and 4 MB of acquisition state. Every page has a persisted checkpoint.
The importer traverses all profile items, assigned variants, product variants, zones
and methods. A final profile/version traversal and product modification checks detect
observed changes and restart affected acquisition; this is not an atomic Shopify
snapshot. Failed/incomplete traversals never retire unseen objects. Only a complete
read can explicitly retire previously mapped, confirmed missing profiles. Complete product comparisons also explicitly remove
previously owned selections/inputs for products that disappeared from Shopify.

The pinned Admin API is **2026-10**. Its published `DeliveryMethodDefinition` schema
exposes `rateProvider` and `methodConditions`. The [shipping option changelog](https://shopify.dev/changelog/posts/new-apis-to-read-and-write-shipping-options-in-delivery-profile)
documents the legacy read expansion of every tier and free condition into separate
methods; all method pages are consumed. A preflight checks the required schema and
granted scope. `read_assigned_shipping` cannot read the complete shop profile/item
membership, so it is insufficient. No shipping write, order, customer or checkout
scope is requested. Any Shopify approval required for `read_shipping` must be
completed in the Partner Dashboard before release; missing access is reported in
shipping status and does not fail catalog sync. Profile webhook subscriptions
belong to this app and use the same shipping read permission. The pinned
[2026-10 WebhookSubscriptionTopic reference](https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic)
lists all three PROFILES topics with `read_shipping` or `read_assigned_shipping`;
full acquisition requires `read_shipping`. No extra scope is needed for
`app/scopes_update`. The pinned webhook examples and backend commit are recorded
in `tests/fixtures/shopify-shipping-webhooks-2026-10.json`.

The supported subset is a profile with one origin group, no unrated origins or
selling-plan applicability, explicit country zones, static rates, minimum
seller-order value conditions and external carrier/app prices. Money is parsed as
decimal strings into exact safe minor units; unsupported currencies/precision stop
publication. All variants must agree before a listing selects one profile. Shopify's
shop-wide profile applies only to variants explicitly marked as requiring shipping;
this flag alone does not establish profile membership or shipping eligibility. Mixed,
incomplete and unsupported membership explicitly suppresses default inheritance.
Profiles with multiple origin groups or selling plans remain unasserted. Province
subsets/rest-of-world zones remain unresolved; weight and upper basket constraints
have no Aura representation and leave the affected service conditional without a
fixed rate. Shopify's cart/profile/location charge groups have no exact Aura charge
basis, so static amounts retain a null basis and a capability notice instead of
claiming a per-item, order or physical-shipment price. Coverage stays partial, and
external prices stay externally calculated.
These rules apply to shops on Shopify's legacy profile model. Shops on
`ShopFeatures.marketDrivenShipping` are read from Markets instead, as described below.
None of these limitations is filled with inferred locations, eligibility, taxes,
packing, duties or checkout prices.

### Market-driven shipping

Shopify moves merchant shipping from delivery profiles into Markets: merchants
opt in from October 1, 2026, and every shop uses the market model by July 1, 2027
([upgrade guide](https://shopify.dev/docs/apps/build/orders-fulfillment/market-driven-shipping/upgrade-your-app)).
For these shops the legacy `deliveryProfile`/`deliveryProfiles` reads can return a
stale snapshot, so the importer never reads them or falls back to them
([#383](https://github.com/aura-historia/shopify-app/issues/383)). Merchants keep their
market settings; returning to legacy profiles is never required.

- **Detection and access.** The preflight reads `shop.features.marketDrivenShipping`.
  `true` selects the Markets read model, which needs `read_markets` (or `write_markets`)
  and the 2026-10 `ShippingConfiguration` fields; `false` keeps the profile importer;
  any other value is an unsupported schema. Missing access is reported as
  `SHIPPING_PERMISSION_REQUIRED` and withdraws owned assertions, as for `read_shipping`.
  The app never calls `marketCreate`/`marketUpdate` or any other mutation.
- **Read surface (Admin API 2026-10).** `markets(sortKey: ID)` reads, 50 per page, each
  market's type, status, condition types, region application level and whether
  `delivery.shipping` is configured and enabled. For active region markets it reads
  `conditions.regionsCondition.regions` (50 per page) and
  `delivery.shipping.optionDefinitions` (5 per page, each with its first rate group and
  up to 25 cart-value tiers). Product and variant traversal is shared with the profile
  importer. Markets have no version, so a second complete read must reproduce the same
  configuration, in any page order, before publication; any difference restarts the
  acquisition. The final verification also re-reads `marketDrivenShipping`, so a shop
  that moves to Markets during a profile read is never published from the deprecated,
  unchanged profiles. Only region markets count toward the 100-market limit. Every
  operation passed 2026-10 schema validation; the sources and the response shapes are in
  `tests/fixtures/shopify-market-shipping-2026-10.json` (values are synthetic).
- **Applicable markets.** Active region markets decide the options of buyers who check
  out from Aura Historia. Company-location (B2B), retail-location (POS) and draft
  markets are not used. Channel markets shape the product feed of a sales channel
  connection; buyers from Aura Historia check out in the online store, where region
  markets apply. Channel markets and markets with combined conditions are therefore
  reported (`MARKET_CONTEXT_UNSUPPORTED`) and not applied, as their prices already are
  not (see [Channel connection](#channel-connection)).
- **Destinations and inheritance.** A destination belongs to the most specific active
  region market containing it. A market without its own shipping inherits from the next
  wider market, following the lineage Shopify infers from strict region subsets; the
  widest one inherits the store default of no shipping. Crossing markets resolve only
  when every path reaches the same shipping; otherwise the destination stays unresolved
  (`MARKET_OVERLAP_UNRESOLVED`). Disabled shipping offers nothing. Shopify subdivision
  codes (such as `CA` in `US`) are not ISO 3166-2 codes, so a country whose parts
  resolve to different shipping, or that is only partly covered, is only an unresolved
  area. A market for all regions becomes an unresolved rest-of-world area plus the
  countries that inherit from it.
- **Options.** Each active option becomes a service whose code derives from its Shopify
  ID. Its rates are representable only from one rate group without collection or
  origin-location conditions, the only group that rates every shippable item alike.
  Shopify's create input sets conditions only when given, so an origin location count
  of zero is read as no location condition; confirm this on a feature-preview store
  before release. Conditioned, multi-group or rate-less options and more than 25
  cart-value tiers stay conditional without a rate (`MARKET_RATE_CONDITIONS_UNSUPPORTED`,
  `MARKET_RATE_TIER_LIMIT`). Otherwise the profile importer's semantics apply: flat rates
  are fixed or free amounts; a cart-value tier with only a lower bound is a threshold,
  while upper bounds and weight-based rates stay conditional; carrier-calculated
  options are calculated at checkout. A free-delivery minimum makes the whole option
  free from that cart subtotal: it adds a free service with a seller-order threshold
  where the option is certainly available (a flat rate, or a cart-value tier open from
  the minimum), and leaves paid prices conditional because they apply only below it.
  Currencies and minor units are exact; an option whose currency or precision Aura
  cannot represent stays conditional (`MARKET_CURRENCY_UNSUPPORTED`) without affecting
  other options. Transit time in whole days or hours becomes the transit lead time
  without a business or calendar basis; other durations stay unasserted. Rate consolidation and split shipping decide the combined checkout
  charge, so amounts keep a null basis with `SHOPIFY_CHARGE_GROUP_BASIS_UNAVAILABLE`.
- **Applicability.** The market configuration is one profile, `shopify:market-shipping`,
  assigned as the source default. Market rates apply to items that require shipping, so
  the rules of a shop-wide profile apply: a product whose variants all require shipping
  selects it explicitly, and mixed or unknown products suppress inheritance. Rates that
  other apps' delivery profiles add in Markets are not read
  (`APP_PROVIDED_RATES_UNASSERTED`).
- **Model switches.** Only a complete acquisition of the current model is published.
  Moving to market-driven shipping retires the imported profile identities; a rollback
  retires the market profile and restores them. Once the preflight finds market-driven
  shipping, terms imported from profiles are known to be stale: if the market import is
  blocked before its profile is published, they are withdrawn like on permission loss
  instead of staying current.
- **Notifications.** `markets/create`, `markets/update` and `markets/delete` are refresh
  hints like profile notifications; their payload carries only the numeric market ID.
  Shopify does not document which shipping option edits update a market, and collection
  or location changes send no shipping notification, so reconciliation within six hours
  guarantees convergence and **Import shipping settings** refreshes at once.
- **Alternatives.** Shopify recommends Contextual Product Feeds for sales channels. Their
  per-variant delivery option estimates are contextualized checkout estimates, not the
  merchant's options and conditions, and this app reads no product feed.
- **Verification.** Tests cover initial import, rate and threshold edits, option and
  market removal, multiple and nested markets, subdivisions, free-delivery minimums,
  currencies, missing access, unsupported fields, retries, model switches (including a
  blocked switch) and read-only Shopify access against the 2026-10 shapes. Before release, repeat this on a development store with the
  **Market-driven shipping** feature preview and submit Shopify's compatibility
  self-attestation.

Status distinguishes queued work, acquisition, publication, partial progress,
protected partner edits and applied operations. Applied means Aura committed the
typed write; discovery indexing remains eventual and no shipping quote is promised.
Use the authenticated **Import shipping settings** action to repair after resolving
permissions, capabilities or a bounded failure. **Refresh shipping status** distinguishes
committed operations from pending work; search indexing remains eventual.

The official generated Aura client is pinned in `openapi-ts.config.ts` to backend
commit `597425dcca064e7128072b988042ab3f9b1aedd1` (the production `/v1` contract).
Run `npm run openapi:generate` to reproduce it; review later contract changes
explicitly. Backend URLs use `/v1`, including `/v1/oauth/token` and `/v1/oauth/revoke`. Browser consent starts at `/en/oauth/authorize`. Catalog and shipping imports share the current currency registry, including ARS and zero-decimal JPY/KRW. `tests/fixtures/shipping-contract.json` is the executable contract
fixture from that contract (its command examples remain unchanged). Ordinary typed shipping writes carry `import` metadata
with `observation: {}` for successful acquisitions, and no expiry/freshness fields.
Protected shipping evidence is excluded from management responses. The strict import/write contract remains separate from the public shipping read projection.

### Continuous refresh and recovery

`app/routes/webhooks.shipping.tsx` is the app-owned receiver. Stage/default and
production declare absolute `https://partner-connect.aura-historia.com/webhooks/shipping`
destinations; localhost development therefore uses the deployed receiver. Tunnel
configuration declares `/webhooks/shipping`, resolved to the active HTTPS tunnel.
The product/compliance EventBridge destinations and uninstall/bulk endpoints retain
their existing destinations. No additional product notification or catalog mutation
is submitted by shipping. A Worker deployment does not activate a new Shopify configuration version. Shopify configuration is released separately with a semver tag; live merchant exports are initiated only by the authorized installation.

The per-shop Durable Object has a transactional hint inbox independent of provider
I/O. It retains up to 512 delivery receipts per source/connection for 48 hours,
returning retryable backpressure at capacity. Delivery IDs deduplicate within that
binding; a reconnect creates a new random connection generation. Callback bodies
are limited to 16 KiB. Topics, API version and profile GIDs are validated. A delete
is a refresh hint: a complete API traversal and final verification must confirm
absence before retiring a previously owned profile. Scope errors, missing pages
and failed reads preserve prior terms and observation age. Scope-change notifications
fence old prepared writes before the next current-access check.

Every bound shop schedules a new reconciliation six hours after successful work.
Paused work gets a bounded new acquisition at that interval; each run retains the
S01 limits (100 profiles, 5,000 products, 4,000 pages, 4 MB). This covers profile
assignment changes, product/variant membership and requires-shipping changes,
origin-group/configuration changes and missed notifications independently of catalog
EventBridge processing. It does not assume that profiles/update observes every
assignment change. Market-driven shops get the same periodic read of their markets,
regions and options. Unsupported origin or market configurations remain
unasserted and actionable. This is acquisition of current state, never TTL renewal
or a scan of backend CDC/SQS pending work. Existing installations enter this schedule
on their next initial/manual import; there is no unbounded installation enumeration.

Worker alarms checkpoint one provider request or typed prepare/send step at a time.
Eight attempts per record/page and exponential delays bound automatic retries.
Missing catalog listings remain deferred with SHIPPING_IMPORT_DEPENDENCY_MISSING,
whether the backend reports that code or an assignment lookup returns the documented
404 PRODUCT_LISTING_NOT_FOUND; other 404s keep their HTTP category. Manual repair
resumes exact pending requests, and the seven-day retention cap bounds old request
bodies. A new complete acquisition may supersede exhausted
work, using stable object identities and a new acquisition order. The callback
inbox does not wait for provider reads and cannot overwrite a connection stop.

Permission loss withdraws owned shipping profiles, defaults, listing selections
and inputs through the existing typed commands. Selection and input removals are
independent; manual edits/clears and collection/shipping overrides stay protected
by backend ownership checks. Product synchronization credentials remain usable.
Uninstall/disconnect queues the same removals, then attempts Aura OAuth token
revocation. OAuth revocation is recorded separately; it is not reported as source
or grant revocation. A reconnect leaves the current connection running until the new
grant has configured the provider and its record is stored. The previous binding's stop,
cleanup and token revocation then commit with the new binding in one serialized step; a
failed attempt revokes only the new grant. Source switching therefore fences old work
and queues cleanup before new acquisition; at most five connection cleanups can be
retained. Removals retain
the last successful source acquisition time, so a newer backend authority boundary
is never bypassed with a new timestamp. Reconnect always reads Shopify again.

Cleanup status distinguishes **pending**, **committed** owned removals, and
**unconfirmed** cleanup. Configuration/authority conflicts, unavailable credentials
or exhausted retries can leave cleanup unconfirmed; it is visible in the embedded
app where the installation is still accessible. Reconnect and import current
settings, or have an authorized source administrator remove the remaining imports
and review source/grant configuration. Stopping locally, erasing sessions or revoking
an OAuth token does not prove that backend assertions were removed. Unconfirmed
assertions can remain available beyond 30 days until explicitly updated/withdrawn
or a backend source/configuration/grant authority change commits. They never expire
because of observation age. Discovery indexing follows existing backend CDC/SQS
continuations and retry/DLQ controls.

### External services and privacy

With the merchant's installation approval, Shopify provides shipping profile
names/IDs, location-group identities, destination areas, advertised
methods/conditions/prices and complete
product/variant membership; for market-driven shops it provides market types,
regions and shipping options/rates instead of profiles. Cloudflare stores bounded private job checkpoints,
resource mappings and immutable pending typed requests. Aura Historia receives only
the canonical terms, source-scoped membership and acquisition metadata through its
authorized API. Shipping requests contain no provider domain, token, session, raw
provider payload, customer data or precise fulfillment address. The separate catalog
ingestion domain configuration remains necessary for existing EventBridge ingestion.
Errors exposed by shipping status contain categories, never provider response bodies
or credentials. Disconnect durably fences publication before admitting cleanup; uninstall also
erases Shopify sessions and the ordinary Aura connection immediately. Only required
Aura credentials for cleanup remain in a separate protected KV entry, with a
seven-day maximum retention. No Shopify token is copied. Cleanup state retains only
canonical typed removal requests and resource identities, then discards them.
Minimal stop/status tombstones are erased after seven days; unknown installations
and hints cannot recreate a binding. A stopped connection record that is still stored
keeps only its stop tombstone until a disconnect, uninstall or new authorization
replaces it; the embedded app reports it as stopped and offers only a new
authorization, never a retry with that record.
The linked Aura privacy policy and App Store access disclosure must reflect this
processing when the feature is released.

## Quality checks

Run the full suite before opening a pull request:

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

| Command | Responsibility |
| --- | --- |
| `npm run lint` | Biome formatting and lint checks |
| `npm run typecheck` | React Router type generation and TypeScript validation |
| `npm run test` | Focused Node test suite |
| `npm run build` | Production React Router build |

GitHub Actions runs these checks across Node.js 22.18, 24.15, and 26.1 on pushes and pull requests. See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## Deployment

The supported runtime is Cloudflare Workers, including KV and Durable Object
bindings. Use `npm run preview` for local production-build preview. The unused
Node server/Docker template has been removed.

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`

```bash
npm run cf-deploy       # Build and deploy the Cloudflare Worker
npm run config:use:prod # Select Shopify production configuration locally
npm run deploy:prod     # Deploy Shopify app configuration to production
```

The GitHub Actions workflow requires these repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `SHOPIFY_APP_AUTOMATION_TOKEN`

See [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) for the release definition. A manual workflow dispatch runs the same checks and deploys only the Worker. A semver tag also releases the production Shopify app configuration. Production URL rewriting by Shopify development commands is disabled.

The Worker keeps OAuth/authenticated responses private and uncached, uses `Referrer-Policy: no-referrer`, and redacts query strings from Cloudflare invocation logs. Catalog progress stores only phase/counts in the shop's catalog importer, is replaced by each new import and is cleared on disconnect, uninstall and connection replacement; access tokens remain only in the separate existing credential stores and in each import's one-hour KV context. Channel counts come from the current Shopify channel connection and retain the API's lower-bound indicator. The bulk editor link targets that connection's publication. Import acceptance is distinct from search visibility.

## Production OAuth

The production Aura Historia client ID is `oc_01m5vyyghjecx8c43drb05hh4n`. Its registered callback is exactly `https://partner-connect.aura-historia.com/oauth/callback`, and its four scopes are configured in `wrangler.jsonc`. The client secret is installed in the production Worker's `AURA_HISTORIA_OAUTH_CLIENT_SECRET` secret binding.

The webapp consent flow supports `/v1`, S256 PKCE, registered callback validation, and `listing_source_id`.

## Public app information

- Website: [aura-historia.com](https://aura-historia.com)
- Privacy: [aura-historia.com/privacy](https://aura-historia.com/privacy)
- Terms: [aura-historia.com/terms-and-conditions](https://aura-historia.com/terms-and-conditions)
- Imprint: [aura-historia.com/imprint](https://aura-historia.com/imprint)
- Support: [contact@aura-historia.com](mailto:contact@aura-historia.com)

## License

Distributed under the [MIT License](./LICENSE). Copyright © 2026 Aura Historia.

---

<p align="center">
  <img src="https://assets.aura-historia.com/branding/banner_twitter_slogan.png" alt="Aura Historia — Where antiques find their story" />
</p>
