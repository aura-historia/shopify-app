import type { LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { createAdminGraphqlRequest, triggerBackfill } from "../backfill.server";
import {
  clearOAuthPendingContext,
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
import { isValidShopId, saveShopCredentials } from "../shop-credentials.server";
import { getShopify } from "../shopify.server";
import styles from "../styles/public-page.module.css";

const legalLinks = [
  { href: "https://aura-historia.com/privacy", label: "Privacy" },
  { href: "https://aura-historia.com/imprint", label: "Imprint" },
  {
    href: "https://aura-historia.com/terms-and-conditions",
    label: "Terms & conditions",
  },
];

type BackfillStatus = "queued" | "missing_shopify_session" | "not_queued";

async function queueInitialBackfill({
  context,
  shopDomain,
  shopId,
  accessToken,
  apiBaseUrl,
}: {
  context: LoaderFunctionArgs["context"];
  shopDomain: string;
  shopId: string;
  accessToken: string;
  apiBaseUrl: string;
}): Promise<BackfillStatus> {
  try {
    const shopify = getShopify(context);
    const { admin } = await shopify.unauthenticated.admin(shopDomain);
    const graphqlRequest = createAdminGraphqlRequest(admin);

    const submitted = await triggerBackfill(
      graphqlRequest,
      context.cloudflare.env.KV,
      shopDomain,
      shopId,
      accessToken,
      apiBaseUrl,
    );

    return submitted ? "queued" : "not_queued";
  } catch (error) {
    if (error instanceof Error && error.name === "SessionNotFoundError") {
      console.error(
        `No offline Shopify session found for ${shopDomain}:`,
        error,
      );
      return "missing_shopify_session";
    }

    console.error(`Failed to queue initial backfill for ${shopDomain}:`, error);
    return "not_queued";
  }
}

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

  const partnerShopId = url.searchParams.get("partner_shop_id");
  if (!partnerShopId || !isValidShopId(partnerShopId)) {
    return fail("Aura Historia did not return a valid partner_shop_id.");
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

  try {
    const token = await exchangeOAuthCodeForToken(
      config,
      code,
      pending.codeVerifier,
    );

    const shopDomain =
      pending.shopDomain || getShopDomainFromStoreName(shopifyStoreName);

    await saveShopCredentials(context.cloudflare.env.KV, shopDomain, {
      shopId: partnerShopId,
      accessToken: token.access_token,
      tokenType: token.token_type,
      scope: token.scope,
      shopifyStoreName,
    });

    const apiBaseUrl =
      getAuraHistoriaApiBaseUrl(context.cloudflare.env) ??
      new URL(config.tokenUrl).origin;
    const backfill = await queueInitialBackfill({
      context,
      shopDomain,
      shopId: partnerShopId,
      accessToken: token.access_token,
      apiBaseUrl,
    });

    await clearOAuthPendingContext(context.cloudflare.env.KV, stateValue);

    return adminRedirect(shopifyStoreName, {
      oauth: "connected",
      backfill,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
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
            <p className={styles.eyebrow}>Shopify partner connect</p>
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
          <section className={styles.introPanel}>
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
