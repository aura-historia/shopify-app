import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import {
  clearBackfillContext,
  configureShopifyListingSource,
  triggerBackfill,
} from "../backfill.server";
import {
  clearCatalogImportStatus,
  getChannelPublication,
  loadCatalogImportStatus,
} from "../catalog.server";
import {
  buildAuraHistoriaOAuthAuthorizeUrl,
  getAuraHistoriaApiBaseUrl,
  getAuraHistoriaOAuthConfig,
  getMissingAuraHistoriaOAuthConfig,
  summarizeOAuthError,
} from "../oauth.server";
import {
  offlineGraphql,
  queueShipping,
  shopCoordinator,
} from "../shipping/runtime.server";
import {
  SHIPPING_PHASE_LABELS,
  shippingIssueMessage,
  shippingLimitationMessage,
} from "../shipping/status";
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

type IntegrationStatus =
  | "connected"
  | "disconnected"
  | "not_connected"
  | "failed"
  | "config_missing";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shopify = getShopify(context);
  const { session, redirect } = await shopify.authenticate.admin(request);
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
  const backfill = url.searchParams.get("backfill");

  return {
    shipping: await shopCoordinator(context, session.shop).status(),
    catalogImport: credentials
      ? await loadCatalogImportStatus(context.cloudflare.env.KV, session.shop)
      : null,
    publication: credentials
      ? await getChannelPublication(
          offlineGraphql(context, session.shop),
          session.shop,
        )
      : null,
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
      shippingQueueError: url.searchParams.get("shipping") === "not_queued",
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
  redirectParams.delete("shipping");

  if (intent === "import_shipping") {
    if (!(await queueShipping(context, session.shop)))
      redirectParams.set("shipping", "not_queued");
    return redirect(`/app?${redirectParams.toString()}`);
  }

  if (intent === "shipping_status") {
    return redirect(`/app?${redirectParams.toString()}`);
  }

  if (intent === "retry_backfill") {
    const credentials = await loadShopCredentials(
      context.cloudflare.env.KV,
      session.shop,
    );
    if (!credentials) {
      redirectParams.set("backfill", "not_queued");
      return redirect(`/app?${redirectParams.toString()}`);
    }

    try {
      const config = getAuraHistoriaOAuthConfig(context.cloudflare.env);
      const apiBaseUrl =
        getAuraHistoriaApiBaseUrl(context.cloudflare.env) ??
        new URL(config.tokenUrl).origin;
      const graphqlRequest = offlineGraphql(context, session.shop);
      const metadata = await configureShopifyListingSource(
        graphqlRequest,
        apiBaseUrl,
        credentials.listingSourceId,
        credentials.accessToken,
        session.shop,
      );
      const queued = await triggerBackfill(
        graphqlRequest,
        context.cloudflare.env.KV,
        session.shop,
        credentials.listingSourceId,
        credentials.accessToken,
        apiBaseUrl,
        metadata,
      );
      redirectParams.set("backfill", queued ? "queued" : "not_queued");
    } catch (error) {
      console.error(
        "Failed to retry initial backfill:",
        summarizeOAuthError(error, [credentials.accessToken]),
      );
      redirectParams.set("backfill", "not_queued");
    }
    return redirect(`/app?${redirectParams.toString()}`);
  }

  if (intent !== "disconnect") {
    redirectParams.set("disconnect_error", "Unknown action.");
    return redirect(`/app?${redirectParams.toString()}`);
  }

  await shopCoordinator(context, session.shop).disconnectShipping(session.shop);
  await clearBackfillContext(context.cloudflare.env.KV, session.shop);
  await clearCatalogImportStatus(context.cloudflare.env.KV, session.shop);
  await clearShopCredentials(context.cloudflare.env.KV, session.shop);
  await markShopCredentialsDisconnected(
    context.cloudflare.env.KV,
    session.shop,
  );

  redirectParams.set("disconnect", "success");
  redirectParams.delete("disconnect_error");

  return redirect(`/app?${redirectParams.toString()}`);
};

function IntentButton({
  intent,
  children,
}: {
  intent: string;
  children: string;
}) {
  const navigation = useNavigation();
  return (
    <Form method="post">
      <input type="hidden" name="intent" value={intent} />
      <s-button type="submit" disabled={navigation.state !== "idle"}>
        {children}
      </s-button>
    </Form>
  );
}

export default function AppIndex() {
  const {
    credentials,
    integration,
    shop,
    shipping,
    publication,
    catalogImport,
  } = useLoaderData<typeof loader>();
  const isConnected = integration.status === "connected";
  const catalogPhase =
    catalogImport?.phase ??
    (integration.backfill === "queued"
      ? "queued"
      : integration.backfill === "not_queued"
        ? "failed"
        : null);
  const manualConnectUrl = createShopifyAdminAppUrl(getShopifyStoreName(shop), {
    manual_connect: "1",
  }).toString();
  const statusLabel = isConnected
    ? "Connected via OAuth"
    : integration.status === "config_missing"
      ? "Connection temporarily unavailable"
      : integration.status === "disconnected"
        ? "Disconnected"
        : integration.status === "failed"
          ? "OAuth connection failed"
          : "Ready to connect";
  const connectButtonLabel =
    integration.status === "disconnected"
      ? "Reconnect Aura Historia"
      : integration.status === "failed"
        ? "Retry Aura Historia connection"
        : "Connect Aura Historia";

  return (
    <s-page heading="Aura Historia">
      <s-section heading="Aura Historia account">
        <s-stack gap="base">
          <s-banner
            heading={statusLabel}
            tone={
              isConnected
                ? "success"
                : integration.status === "failed"
                  ? "critical"
                  : "info"
            }
          >
            <s-paragraph>
              {isConnected
                ? "Your Shopify store is connected to Aura Historia. Shoppers discover your products there and complete checkout in your Shopify store."
                : "Connect an Aura Historia account with permission to manage a listing source. If you do not have access yet, complete partner onboarding on Aura Historia before connecting."}
            </s-paragraph>
          </s-banner>
          <s-paragraph>{shop}</s-paragraph>
          {credentials && (
            <s-paragraph>
              Listing source: {credentials.listingSourceId}. Last configured:{" "}
              {credentials.updatedAt}.
            </s-paragraph>
          )}
          {integration.status === "config_missing" && (
            <s-paragraph>
              Contact support to restore the connection service.
            </s-paragraph>
          )}
          {integration.status === "failed" && (
            <s-paragraph>
              The connection could not finish. Try connecting again or contact
              support.
            </s-paragraph>
          )}
          <s-stack direction="inline" gap="base">
            {isConnected ? (
              <IntentButton intent="disconnect">
                Disconnect Aura Historia
              </IntentButton>
            ) : (
              integration.status !== "config_missing" && (
                <s-button
                  variant="primary"
                  href={manualConnectUrl}
                  target="_top"
                >
                  {connectButtonLabel}
                </s-button>
              )
            )}
            <s-link
              href="https://aura-historia.com/en/partner-program"
              target="_blank"
            >
              Aura Historia partner onboarding
            </s-link>
          </s-stack>
          <s-paragraph>
            Connecting authorizes catalog and advertised shipping imports. You
            can disconnect here or uninstall the channel in Shopify at any time.
          </s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading="Publishing">
        <s-stack gap="base">
          {!isConnected ? (
            <s-paragraph>
              Connect your Aura Historia account to start importing your
              catalog.
            </s-paragraph>
          ) : (
            <>
              <s-paragraph>
                {publication
                  ? `${publication.atLeast ? "At least " : ""}${publication.count} active products included in this Shopify channel.`
                  : "The current Shopify publication count is unavailable. Refresh this page or contact support if the issue continues."}
              </s-paragraph>
              <s-paragraph>
                Catalog imports are processed in the background. Acceptance by
                Aura Historia does not mean an item is already visible in
                search.
              </s-paragraph>
              {(integration.backfill === "not_queued" ||
                catalogPhase === "failed") && (
                <s-banner
                  tone="critical"
                  heading="Catalog import needs attention"
                >
                  <s-paragraph>
                    {catalogImport?.failed
                      ? `${catalogImport.failed} products could not be submitted. Review their product data and retry the import.`
                      : "The catalog import did not finish. Retry the import or contact support."}
                  </s-paragraph>
                </s-banner>
              )}
              {catalogPhase === "queued" && (
                <s-paragraph>Initial product backfill was queued.</s-paragraph>
              )}
              {catalogPhase === "processing" && (
                <s-paragraph>
                  The catalog is being submitted to Aura Historia. Refresh this
                  page for an update.
                </s-paragraph>
              )}
              {catalogImport?.phase === "submitted" && (
                <s-paragraph>
                  Last import: {catalogImport.total} products processed,{" "}
                  {catalogImport.failed} submission failures.
                </s-paragraph>
              )}
              <s-stack direction="inline" gap="base">
                {publication && (
                  <s-button href={publication.editorUrl} target="_top">
                    Manage products in Shopify bulk editor
                  </s-button>
                )}
                <IntentButton intent="retry_backfill">
                  Import catalog again
                </IntentButton>
              </s-stack>
            </>
          )}
          <s-link href="https://aura-historia.com" target="_blank">
            View the Aura Historia marketplace
          </s-link>
        </s-stack>
      </s-section>

      {isConnected && (
        <s-section heading="Advertised shipping">
          <s-stack gap="base">
            <s-paragraph>
              {SHIPPING_PHASE_LABELS[shipping?.phase ?? "idle"]}:{" "}
              {shipping?.committed ?? 0} operations applied,{" "}
              {shipping?.pending ?? 0} pending, {shipping?.protected ?? 0}{" "}
              partner edits preserved, {shipping?.failures ?? 0} failed. Applied
              changes can take time to appear in search. Checkout determines the
              shipping quote.
            </s-paragraph>
            {shipping?.error && (
              <s-banner
                tone="warning"
                heading="Shipping import needs attention"
              >
                <s-paragraph>
                  {shippingIssueMessage(shipping.error)}
                </s-paragraph>
              </s-banner>
            )}
            {!!shipping?.limitations.length && (
              <s-unordered-list>
                {shipping.limitations.map((code) => (
                  <s-list-item key={code}>
                    {shippingLimitationMessage(code)}
                  </s-list-item>
                ))}
              </s-unordered-list>
            )}
            {integration.shippingQueueError && (
              <s-banner tone="warning">
                <s-paragraph>
                  The shipping import could not be queued. Try again.
                </s-paragraph>
              </s-banner>
            )}
            <s-paragraph>
              Current settings are imported after connection. Profile changes
              refresh automatically, and periodic checks repair missed changes.
              Product synchronization continues independently.
            </s-paragraph>
            <s-stack direction="inline" gap="base">
              <IntentButton intent="import_shipping">
                Import shipping settings
              </IntentButton>
              <IntentButton intent="shipping_status">
                Refresh shipping status
              </IntentButton>
            </s-stack>
          </s-stack>
        </s-section>
      )}
      {shipping?.cleanup && (
        <s-banner
          tone={shipping.cleanup === "committed" ? "success" : "warning"}
          heading="Previous connection cleanup"
        >
          <s-paragraph>
            {shipping.cleanup === "pending"
              ? "Shipping synchronization has stopped for the previous connection. Removal of its imported assertions is pending."
              : shipping.cleanup === "committed"
                ? "Removal of the previous connection's owned shipping assertions committed. Manual edits were preserved."
                : "Shipping synchronization has stopped. Removal could not be confirmed. Prior imported terms may remain available; reconnect and import again or contact support."}
          </s-paragraph>
          {!isConnected &&
            shipping.cleanup === "committed" &&
            !shipping.tokenRevoked && (
              <s-paragraph>
                Authorization revocation could not be confirmed. Contact support
                to review the remaining access.
              </s-paragraph>
            )}
        </s-banner>
      )}

      <s-section heading="Terms and support">
        <s-stack gap="base">
          <s-paragraph>
            The Aura Historia Shopify app is free to install and use. There are
            no charges or commissions.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-link
              href="https://aura-historia.com/en/terms-and-conditions"
              target="_blank"
            >
              Terms &amp; conditions
            </s-link>
            <s-link href="https://aura-historia.com/en/privacy" target="_blank">
              Privacy
            </s-link>
            <s-link href="https://aura-historia.com/en/imprint" target="_blank">
              Imprint
            </s-link>
            <s-link href="mailto:contact@aura-historia.com">
              contact@aura-historia.com
            </s-link>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
