import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
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
  loadShopCredentials,
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
        description: "Used so uninstall cleanup can remove stored sessions.",
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

type IntegrationStatus = "connected" | "failed" | "config_missing";

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
  const credentials = await loadShopCredentials(
    context.cloudflare.env.KV,
    session.shop,
  );
  const oauthResult = url.searchParams.get("oauth");
  const manualConnect = url.searchParams.get("manual_connect") === "1";

  if (!credentials && (manualConnect || oauthResult !== "failed")) {
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
    : missingConfig.length > 0
      ? "config_missing"
      : "failed";
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
      backfill,
      missingConfig,
    },
  };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { session } = await getShopify(context).authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "disconnect") {
    return { disconnected: false, error: "Unknown action." };
  }

  const credentials = await loadShopCredentials(
    context.cloudflare.env.KV,
    session.shop,
  );
  if (!credentials) {
    return { disconnected: false, error: "Aura Historia is not connected." };
  }

  const config = getAuraHistoriaOAuthConfig(context.cloudflare.env);
  const missingConfig = getMissingAuraHistoriaOAuthConfig(config);

  try {
    if (missingConfig.length === 0) {
      await revokeAuraHistoriaAccessToken(config, credentials.accessToken);
    }
  } catch (error) {
    return {
      disconnected: false,
      error: `Disconnect failed: ${summarizeOAuthError(error)}`,
    };
  }

  await clearShopCredentials(context.cloudflare.env.KV, session.shop);

  return { disconnected: true, error: null };
};

export default function AppIndex() {
  const { credentials, integration, shop, scopes } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const isConnected = integration.status === "connected";
  const canManualConnect = integration.status === "failed";
  const canDisconnect = isConnected;
  const manualConnectUrl = createShopifyAdminAppUrl(getShopifyStoreName(shop), {
    manual_connect: "1",
  }).toString();
  const statusLabel = isConnected
    ? "Connected via OAuth"
    : integration.status === "config_missing"
      ? "OAuth environment incomplete"
      : "OAuth connection failed";
  const statusDescription = isConnected
    ? "This Shopify installation is mapped to Aura Historia."
    : integration.status === "config_missing"
      ? "The app cannot start Aura Historia OAuth until the required OAuth client environment variables are configured."
      : "The automatic OAuth flow did not finish. Reopen the app to retry once the issue below is resolved.";

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Shopify partner connect</p>
          <h1 className={styles.heading}>
            Aura Historia connects automatically.
          </h1>
          <p className={styles.lead}>
            Aura Historia usually is automatically connected. You can check the
            status below. If it didn't connect, you can manually connect it by
            clicking
            <em> "Connect Aura Historia manually"</em>. You can disconnect or
            uninstall this Shopify App at any time.
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
            <span className={styles.topicName}>OAuth Access-Token</span>
            <span className={styles.topicDescription}>
              {credentials?.hasAccessToken
                ? `${credentials.accessTokenPreview ?? "aurahistoria_…"}.`
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
            <span className={styles.topicName}>Initial Product-Backfill</span>
            <span className={styles.topicDescription}>
              {getBackfillMessage(integration.backfill)}
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
              Connect Aura Historia manually
            </a>
          ) : (
            <button
              className={`${styles.primaryButton} ${styles.disabledButton}`}
              type="button"
              disabled
            >
              {isConnected
                ? "Aura Historia already connected"
                : "Manual connect unavailable"}
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
        {actionData?.disconnected ? (
          <p className={styles.successText}>
            Aura Historia was disconnected for this shop.
          </p>
        ) : null}
        {actionData?.error ? (
          <p className={styles.errorText}>{actionData.error}</p>
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
              href="https://aura-historia.com/partners/shopify"
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
