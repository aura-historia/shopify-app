import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";
import { createAdminGraphqlRequest, triggerBackfill } from "../backfill.server";
import {
  buildAuraHistoriaOAuthAuthorizeUrl,
  getAuraHistoriaApiBaseUrl,
  getAuraHistoriaOAuthConfig,
  getMissingAuraHistoriaOAuthConfig,
  revokeAuraHistoriaAccessToken,
  summarizeOAuthError,
} from "../oauth.server";
import {
  clearShopCredentials,
  clearShopCredentialsDisconnected,
  isShopCredentialsDisconnected,
  loadShopCredentials,
  markShopCredentialsDisconnected,
  toPublicShopCredentialsRecord,
} from "../shop-credentials.server";
import { getShopify } from "../shopify.server";
import {
  createShopifyAdminAppUrl,
  getShopifyStoreName,
} from "../shopify-admin-url";
import styles from "../styles/app-home.module.css";

const accessSections = [
  {
    title: "Products",
    description: "Product lifecycle events are forwarded to Aura Historia.",
    items: [
      {
        name: "products/create",
        description: "New catalog entries are delivered without manual export.",
      },
      {
        name: "products/update",
        description: "Edits stay in sync as merchants refine their listings.",
      },
      {
        name: "products/delete",
        description: "Removals are passed on so downstream records can close.",
      },
    ],
  },
  {
    title: "Compliance & uninstall",
    description: "Mandatory public-app webhooks are in place.",
    items: [
      {
        name: "customers/data_request",
        description: "Required for Shopify privacy and compliance handling.",
      },
      {
        name: "customers/redact",
        description: "Required when customer data must be erased.",
      },
      {
        name: "shop/redact",
        description: "Required when shop-level data must be erased.",
      },
      {
        name: "app/uninstalled",
        description:
          "Used so uninstall cleanup can remove stored sessions and connection data.",
      },
    ],
  },
  {
    title: "Locale & shop context",
    description: "Read-only shop data keeps product sync mapped correctly.",
    items: [
      {
        name: "read_locales",
        description: "Used to map product content to the shop language.",
      },
      {
        name: "shop domain",
        description: "Used to associate this installation with the right shop.",
      },
      {
        name: "currency",
        description: "Used so partner-side pricing stays aligned with Shopify.",
      },
    ],
  },
];

type IntegrationStatus =
  | "connected"
  | "disconnected"
  | "not_connected"
  | "failed"
  | "config_missing";

function waitUntil(ctx: unknown, promise: Promise<unknown>) {
  const waitUntilContext = ctx as {
    waitUntil?: (promise: Promise<unknown>) => void;
  };
  if (typeof waitUntilContext.waitUntil === "function") {
    waitUntilContext.waitUntil(promise);
  }
}

function getBackfillMessage(backfillStatus: string | null) {
  switch (backfillStatus) {
    case "queued":
      return "Initial product backfill was queued.";
    case "missing_shopify_session":
      return "OAuth credentials were saved, but no offline Shopify session was available to queue the initial backfill.";
    case "not_queued":
      return "OAuth credentials were saved, but the initial backfill could not be queued. Product webhooks remain configured.";
    default:
      return "Backfill status is not part of this launch. Product webhooks remain configured for ongoing changes.";
  }
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopify = getShopify(context);
  const { session, redirect, admin } =
    await shopify.authenticate.admin(request);
  const storedCredentials = await loadShopCredentials(
    context.cloudflare.env.KV,
    session.shop,
  );
  const disconnectedByAction = url.searchParams.get("disconnect") === "success";
  const credentials = disconnectedByAction ? null : storedCredentials;
  const oauthResult = url.searchParams.get("oauth");
  const manualConnect = url.searchParams.get("manual_connect") === "1";
  const manuallyDisconnected = credentials
    ? false
    : disconnectedByAction ||
      (await isShopCredentialsDisconnected(
        context.cloudflare.env.KV,
        session.shop,
      ));
  const connectionPaused = manuallyDisconnected && !manualConnect;

  if (manualConnect) {
    await clearShopCredentialsDisconnected(
      context.cloudflare.env.KV,
      session.shop,
    );
  }

  if (!credentials && !connectionPaused && manualConnect) {
    const authorization = await buildAuraHistoriaOAuthAuthorizeUrl(
      context.cloudflare.env.KV,
      context.cloudflare.env,
      session.shop,
    );

    if (authorization.isReady) {
      return redirect(authorization.url.toString(), {
        target: "_parent",
      });
    }
  }

  const config = getAuraHistoriaOAuthConfig(context.cloudflare.env);
  const missingConfig = getMissingAuraHistoriaOAuthConfig(config);
  const status: IntegrationStatus = credentials
    ? "connected"
    : connectionPaused
      ? "disconnected"
      : missingConfig.length > 0
        ? "config_missing"
        : oauthResult === "failed"
          ? "failed"
          : "not_connected";
  let backfill = url.searchParams.get("backfill");

  if (
    credentials &&
    (backfill === "missing_shopify_session" || backfill === "not_queued")
  ) {
    const apiBaseUrl =
      getAuraHistoriaApiBaseUrl(context.cloudflare.env) ??
      new URL(config.tokenUrl).origin;
    const graphqlRequest = createAdminGraphqlRequest(admin);

    waitUntil(
      context.cloudflare.ctx,
      triggerBackfill(
        graphqlRequest,
        context.cloudflare.env.KV,
        session.shop,
        credentials.shopId,
        credentials.accessToken,
        apiBaseUrl,
      ),
    );
    backfill = "queued";
  }

  return {
    credentials: credentials
      ? toPublicShopCredentialsRecord(credentials)
      : null,
    shop: session.shop,
    scopes:
      session.scope
        ?.split(",")
        .map((scope: string) => scope.trim())
        .filter(Boolean) ?? [],
    integration: {
      status,
      error: url.searchParams.get("oauth_error"),
      disconnectError: url.searchParams.get("disconnect_error"),
      disconnected: disconnectedByAction,
      backfill,
      missingConfig,
    },
  };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const url = new URL(request.url);
  const { session } = await getShopify(context).authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const redirectParams = new URLSearchParams(url.searchParams);

  redirectParams.delete("manual_connect");
  redirectParams.delete("oauth");
  redirectParams.delete("oauth_error");
  redirectParams.delete("backfill");

  if (intent !== "disconnect") {
    redirectParams.set("disconnect_error", "Unknown action.");
    return redirect(`/app?${redirectParams.toString()}`);
  }

  const credentials = await loadShopCredentials(
    context.cloudflare.env.KV,
    session.shop,
  );

  if (credentials) {
    const config = getAuraHistoriaOAuthConfig(context.cloudflare.env);
    const missingConfig = getMissingAuraHistoriaOAuthConfig(config);

    if (missingConfig.length === 0) {
      try {
        await revokeAuraHistoriaAccessToken(config, credentials.accessToken);
      } catch (error) {
        console.warn("Failed to revoke Aura Historia access on disconnect", {
          shop: session.shop,
          error: summarizeOAuthError(error),
        });
      }
    }
  }

  await clearShopCredentials(context.cloudflare.env.KV, session.shop);
  await markShopCredentialsDisconnected(
    context.cloudflare.env.KV,
    session.shop,
  );

  redirectParams.set("disconnect", "success");
  redirectParams.delete("disconnect_error");

  return redirect(`/app?${redirectParams.toString()}`);
};

export default function AppIndex() {
  const { credentials, integration, shop, scopes } =
    useLoaderData<typeof loader>();
  const isConnected = integration.status === "connected";
  const isDisconnected = integration.status === "disconnected";
  const isNotConnected = integration.status === "not_connected";
  const canManualConnect =
    isNotConnected || isDisconnected || integration.status === "failed";
  const canDisconnect = isConnected;
  const manualConnectUrl = createShopifyAdminAppUrl(getShopifyStoreName(shop), {
    manual_connect: "1",
  }).toString();
  const statusLabel = isConnected
    ? "Connected via OAuth"
    : integration.status === "config_missing"
      ? "OAuth environment incomplete"
      : isNotConnected
        ? "Ready to connect"
        : isDisconnected
          ? "Disconnected"
          : "OAuth connection failed";
  const statusDescription = isConnected
    ? "This Shopify installation is mapped to Aura Historia."
    : integration.status === "config_missing"
      ? "The app cannot start Aura Historia OAuth until the required OAuth client environment variables are configured."
      : isNotConnected
        ? "Shopify installation is approved. Connect Aura Historia from this merchant UI to finish the partner authorization."
        : isDisconnected
          ? "Aura Historia is disconnected for this shop until you reconnect it."
          : "The OAuth flow did not finish. Retry the Aura Historia connection once the issue below is resolved.";
  const connectButtonLabel = isNotConnected
    ? "Connect Aura Historia"
    : isDisconnected
      ? "Reconnect Aura Historia"
      : "Retry Aura Historia connection";

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Shopify partner connect</p>
          <h1 className={styles.heading}>Connect Aura Historia.</h1>
          <p className={styles.lead}>
            Check the connection status below and start Aura Historia
            authorization from this embedded app. You can disconnect the
            integration or uninstall the Shopify app at any time.
          </p>
        </div>

        <aside className={styles.sidePanel}>
          <section className={styles.panelMuted}>
            <h2 className={styles.cardTitle}>Installed for</h2>
            <p className={styles.cardBody}>
              <span className={styles.shopName}>{shop}</span>
            </p>
            <div className={styles.tagList}>
              {(scopes.length > 0 ? scopes : ["read_products"]).map(
                (scope: string) => (
                  <span key={scope} className={styles.tag}>
                    {scope}
                  </span>
                ),
              )}
            </div>
          </section>

          <section className={styles.panel}>
            <h2 className={styles.cardTitle}>Configuration status</h2>
            <p className={styles.cardBody}>
              <strong>{statusLabel}.</strong> {statusDescription}
            </p>
          </section>
        </aside>
      </section>

      <section className={isConnected ? styles.panel : styles.panelMuted}>
        <h2 className={styles.cardTitle}>Aura Historia integration status</h2>
        <ul className={styles.topicList}>
          <li className={styles.topicItem}>
            <span className={styles.topicName}>Aura Historia access</span>
            <span className={styles.topicDescription}>
              {credentials?.hasAccessToken
                ? "Secure token stored."
                : "Not stored yet."}
            </span>
          </li>
          <li className={styles.topicItem}>
            <span className={styles.topicName}>
              Aura Historia Partner-Shop ID
            </span>
            <span className={styles.topicDescription}>
              {credentials?.shopId ?? "Not mapped yet."}
            </span>
          </li>
          <li className={styles.topicItem}>
            <span className={styles.topicName}>Last configured</span>
            <span className={styles.topicDescription}>
              {credentials?.updatedAt ?? "Not configured yet."}
            </span>
          </li>
        </ul>

        {integration.status === "failed" && integration.error ? (
          <p className={styles.errorText}>OAuth error: {integration.error}</p>
        ) : null}

        {integration.status === "config_missing" ? (
          <p className={styles.errorText}>
            Missing environment variables:{" "}
            {integration.missingConfig.join(", ")}
          </p>
        ) : null}

        <div className={styles.linkRow}>
          {canManualConnect ? (
            <a
              className={styles.primaryButton}
              href={manualConnectUrl}
              target="_top"
            >
              {connectButtonLabel}
            </a>
          ) : (
            <button
              className={`${styles.primaryButton} ${styles.disabledButton}`}
              type="button"
              disabled
            >
              {isConnected
                ? "Aura Historia already connected"
                : "Connection retry unavailable"}
            </button>
          )}

          <Form method="post">
            <input type="hidden" name="intent" value="disconnect" />
            <button
              className={`${styles.secondaryButton} ${!canDisconnect ? styles.disabledButton : ""}`}
              type="submit"
              disabled={!canDisconnect}
            >
              Disconnect Aura Historia
            </button>
          </Form>
        </div>

        {integration.disconnected ? (
          <p className={styles.successText}>
            Aura Historia was disconnected for this shop.
          </p>
        ) : null}
        {integration.disconnectError ? (
          <p className={styles.errorText}>{integration.disconnectError}</p>
        ) : null}
      </section>

      <section className={styles.grid}>
        {accessSections.map((section, index) => (
          <article
            key={section.title}
            className={index === 1 ? styles.panelMuted : styles.panel}
          >
            <h2 className={styles.cardTitle}>{section.title}</h2>
            <p className={styles.cardBody}>{section.description}</p>
            <ul className={styles.topicList}>
              {section.items.map((topic) => (
                <li key={topic.name} className={styles.topicItem}>
                  <span className={styles.topicName}>{topic.name}</span>
                  <span className={styles.topicDescription}>
                    {topic.description}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))}

        <article className={styles.panel}>
          <h2 className={styles.cardTitle}>Further information and policies</h2>
          <div className={styles.linkRow}>
            <a className={styles.link} href="https://aura-historia.com">
              Main website
            </a>
            <a
              className={styles.link}
              href="https://apps.shopify.com/aura-historia-partner-connect"
            >
              Further information
            </a>
            <a className={styles.link} href="https://aura-historia.com/privacy">
              Privacy
            </a>
            <a className={styles.link} href="https://aura-historia.com/imprint">
              Imprint
            </a>
            <a
              className={styles.link}
              href="https://aura-historia.com/terms-and-conditions"
            >
              Terms & conditions
            </a>
          </div>
          <p className={styles.cardBody}>
            Direct contact:{" "}
            <a
              className={styles.contact}
              href="mailto:contact@aura-historia.com"
            >
              contact@aura-historia.com
            </a>
          </p>
        </article>
      </section>
    </div>
  );
}
