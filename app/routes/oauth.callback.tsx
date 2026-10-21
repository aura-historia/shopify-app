import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import {
  configureShopifyListingSource,
  triggerBackfill,
} from "../backfill.server";
import {
  clearOAuthPendingContext,
  connectAuraHistoriaShop,
  createShopifyAdminAppUrl,
  decodeOAuthState,
  exchangeOAuthCodeForToken,
  getAuraHistoriaApiBaseUrl,
  getAuraHistoriaOAuthConfig,
  getMissingAuraHistoriaOAuthConfig,
  getShopDomainFromStoreName,
  loadOAuthPendingContext,
  summarizeOAuthError,
} from "../oauth.server";
import {
  offlineGraphql,
  queueShipping,
  shopCoordinator,
} from "../shipping/runtime.server";
import { isValidListingSourceId } from "../shop-credentials.server";
import styles from "../styles/public-page.module.css";

const legalLinks = [
  { href: "https://aura-historia.com/privacy", label: "Privacy" },
  { href: "https://aura-historia.com/imprint", label: "Imprint" },
  {
    href: "https://aura-historia.com/terms-and-conditions",
    label: "Terms & conditions",
  },
];

function adminRedirect(
  shopifyStoreName: string,
  params: Record<string, string | undefined>,
) {
  return redirect(
    createShopifyAdminAppUrl(shopifyStoreName, params).toString(),
  );
}

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const stateValue = url.searchParams.get("state");
  const state = stateValue ? decodeOAuthState(stateValue) : null;
  const shopifyStoreName = state?.shopify_store_name;

  const fail = async (message: string) => {
    const summarizedMessage = summarizeOAuthError(message);
    if (stateValue) {
      await clearOAuthPendingContext(context.cloudflare.env.KV, stateValue);
    }

    if (shopifyStoreName) {
      return adminRedirect(shopifyStoreName, {
        oauth: "failed",
        oauth_error: summarizedMessage,
      });
    }

    return {
      ok: false,
      message: summarizedMessage,
    };
  };

  const authorizationError =
    url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (authorizationError) {
    return fail(authorizationError);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return fail("Aura Historia did not return an OAuth authorization code.");
  }

  const listingSourceId = url.searchParams.get("listing_source_id");
  if (!listingSourceId || !isValidListingSourceId(listingSourceId)) {
    return fail("Aura Historia did not return a valid listing_source_id.");
  }

  if (!stateValue || !state || !shopifyStoreName) {
    return fail("The OAuth state was missing or invalid.");
  }

  const pending = await loadOAuthPendingContext(
    context.cloudflare.env.KV,
    stateValue,
  );
  if (!pending) {
    return fail("The OAuth state expired. Reopen the Shopify app to retry.");
  }

  if (pending.shopifyStoreName !== shopifyStoreName) {
    return fail("The OAuth state does not match the Shopify store.");
  }

  const config = getAuraHistoriaOAuthConfig(context.cloudflare.env);
  const missingConfig = getMissingAuraHistoriaOAuthConfig(config);
  if (missingConfig.length > 0) {
    return fail(
      `OAuth is not configured. Missing: ${missingConfig.join(", ")}.`,
    );
  }

  const shopDomain =
    pending.shopDomain || getShopDomainFromStoreName(shopifyStoreName);
  const apiBaseUrl =
    getAuraHistoriaApiBaseUrl(context.cloudflare.env) ??
    new URL(config.tokenUrl).origin;
  let issuedToken: string | undefined;
  try {
    const token = await exchangeOAuthCodeForToken(
      config,
      code,
      pending.codeVerifier,
    );
    issuedToken = token.access_token;

    const backfill = await connectAuraHistoriaShop(
      context.cloudflare.env.KV,
      shopDomain,
      {
        listingSourceId,
        accessToken: token.access_token,
        tokenType: token.token_type,
        scope: token.scope,
        shopifyStoreName,
      },
      config,
      async () => {
        await shopCoordinator(context, shopDomain).prepareConnection(
          shopDomain,
        );
        const graphqlRequest = offlineGraphql(context, shopDomain);
        const metadata = await configureShopifyListingSource(
          graphqlRequest,
          apiBaseUrl,
          listingSourceId,
          token.access_token,
          shopDomain,
        );
        return { graphqlRequest, metadata };
      },
      async ({ graphqlRequest, metadata }) =>
        (await triggerBackfill(
          graphqlRequest,
          context.cloudflare.env.KV,
          shopDomain,
          listingSourceId,
          token.access_token,
          apiBaseUrl,
          metadata,
        ))
          ? "queued"
          : "not_queued",
      () =>
        shopCoordinator(context, shopDomain).saveConnection(shopDomain, {
          listingSourceId,
          accessToken: token.access_token,
          tokenType: token.token_type,
          scope: token.scope,
          shopifyStoreName,
        }),
    );

    const shippingQueued = await queueShipping(context, shopDomain);

    try {
      await clearOAuthPendingContext(context.cloudflare.env.KV, stateValue);
    } catch {
      // The connection is durable; pending state will expire on its own.
    }

    return adminRedirect(shopifyStoreName, {
      oauth: "connected",
      backfill,
      ...(shippingQueued ? {} : { shipping: "not_queued" }),
    });
  } catch (error) {
    return fail(
      summarizeOAuthError(error, [
        config.clientSecret,
        pending.codeVerifier,
        issuedToken,
      ]),
    );
  }
};

export default function OAuthCallbackResult() {
  const data = useLoaderData<typeof loader>();

  if (data.ok !== false) {
    return null;
  }

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brandBlock}>
            <p className={styles.eyebrow}>Shopify sales channel</p>
            <a className={styles.brand} href="https://aura-historia.com">
              Aura Historia
            </a>
            <p className={styles.brandMeta}>
              The Shopify installation reached the Aura Historia OAuth callback,
              but the integration could not be completed.
            </p>
          </div>
          <nav className={styles.headerLinks} aria-label="Aura Historia links">
            {legalLinks.map((link) => (
              <a key={link.href} className={styles.link} href={link.href}>
                {link.label}
              </a>
            ))}
            <a
              className={styles.contact}
              href="mailto:contact@aura-historia.com"
            >
              contact@aura-historia.com
            </a>
          </nav>
        </header>

        <main className={styles.hero}>
          <section className={styles.introPanel} data-theme="dark">
            <span className={styles.tag}>Connection failed</span>
            <h1 className={`${styles.title} ${styles.wideTitle}`}>
              Aura Historia OAuth could not finish.
            </h1>
            <p className={styles.lead}>{data.message}</p>
            <div className={styles.buttonRow}>
              <a
                className={styles.primaryAction}
                href="https://aura-historia.com"
              >
                Visit aura-historia.com
              </a>
              <a
                className={styles.secondaryAction}
                href="mailto:contact@aura-historia.com"
              >
                Contact support
              </a>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
