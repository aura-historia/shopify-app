import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import styles from "../styles/public-page.module.css";

const legalLinks = [
  { href: "https://aura-historia.com/privacy", label: "Privacy" },
  { href: "https://aura-historia.com/imprint", label: "Imprint" },
  {
    href: "https://aura-historia.com/terms-and-conditions",
    label: "Terms & conditions",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const host = url.searchParams.get("host");
  const integration = url.searchParams.get("integration");
  const missingConfig = url.searchParams.get("missing");

  const appSearchParams = new URLSearchParams();
  if (shop) {
    appSearchParams.set("shop", shop);
    if (host) {
      appSearchParams.set("host", host);
    }
  }

  return {
    shop,
    appUrl: shop ? `/app?${appSearchParams.toString()}` : null,
    integration,
    missingConfig,
  };
};

export default function SuccessPage() {
  const { appUrl, integration, missingConfig, shop } =
    useLoaderData<typeof loader>();
  const oauthConfigMissing = integration === "oauth-config-missing";

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brandBlock}>
            <p className={styles.eyebrow}>Installation approved</p>
            <a className={styles.brand} href="https://aura-historia.com">
              Aura Historia
            </a>
            <p className={styles.brandMeta}>
              {oauthConfigMissing
                ? "Shopify approval is complete, but Aura Historia OAuth still needs runtime configuration."
                : "The Shopify sales channel connection is now active and Aura Historia can begin receiving product lifecycle changes over Amazon EventBridge."}
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
            <span className={styles.tag}>
              {oauthConfigMissing ? "Action required" : "Success"}
            </span>
            <h1 className={`${styles.title} ${styles.wideTitle}`}>
              {oauthConfigMissing ? (
                <>
                  Shopify approved{" "}
                  <span className={styles.shopName}>{shop}</span>, but OAuth is
                  not configured yet.
                </>
              ) : shop ? (
                <>
                  Aura Historia Sales Channel is now connected to{" "}
                  <span className={styles.shopName}>{shop}</span>.
                </>
              ) : (
                "Aura Historia Sales Channel is now connected to your Shopify store."
              )}
            </h1>
            <p className={styles.lead}>
              {oauthConfigMissing
                ? `Set the missing OAuth environment variables${
                    missingConfig ? ` (${missingConfig})` : ""
                  } and reopen the embedded app to complete Aura Historia authorization automatically.`
                : "Shopify approval is complete. Product create, update, and delete events can now flow through the configured EventBridge pipeline to Aura Historia for sales channel publishing."}
            </p>

            <div className={styles.buttonRow}>
              <a
                className={styles.primaryAction}
                href="https://aura-historia.com"
              >
                Visit aura-historia.com
              </a>
              {appUrl ? (
                <a className={styles.secondaryAction} href={appUrl}>
                  Open the embedded app
                </a>
              ) : null}
            </div>

            <div className={styles.grid}>
              <article className={styles.surfaceCard}>
                <h2 className={styles.cardTitle}>What happens next</h2>
                <p className={styles.cardBody}>
                  {oauthConfigMissing
                    ? "The Shopify installation is approved, but the Aura Historia access token and partner shop ID were not stored because OAuth client settings are missing."
                    : "Aura Historia now listens for Shopify product lifecycle events, publishes products to its discovery surface, and keeps the public-app compliance subscriptions in place for ongoing App Store eligibility."}
                </p>
              </article>
              <article className={styles.surfaceCardStrong}>
                <h2 className={styles.cardTitle}>Need help?</h2>
                <p className={styles.cardBody}>
                  For onboarding questions, support, or review follow-up, write
                  directly to{" "}
                  <a
                    className={styles.contact}
                    href="mailto:contact@aura-historia.com"
                  >
                    contact@aura-historia.com
                  </a>
                  .
                </p>
              </article>
            </div>
          </section>

          <aside className={styles.supportPanel}>
            <section className={styles.surfaceCardStrong}>
              <h2 className={styles.cardTitle}>Aura Historia links</h2>
              <div className={styles.footerLinks}>
                <a className={styles.link} href="https://aura-historia.com">
                  Main website
                </a>
                {legalLinks.map((link) => (
                  <a key={link.href} className={styles.link} href={link.href}>
                    {link.label}
                  </a>
                ))}
              </div>
            </section>

            <section className={styles.surfaceCard}>
              <h2 className={styles.cardTitle}>Review and support</h2>
              <p className={styles.cardBody}>
                Keep these links handy for Shopify App Store review, merchant
                support, and legal contact requirements.
              </p>
              <p className={styles.footerMeta}>
                Direct contact:{" "}
                <a
                  className={styles.contact}
                  href="mailto:contact@aura-historia.com"
                >
                  contact@aura-historia.com
                </a>
              </p>
            </section>
          </aside>
        </main>

        <footer className={styles.footer}>
          <p className={styles.footerTitle}>Aura Historia policies</p>
          <div className={styles.footerLinks}>
            {legalLinks.map((link) => (
              <a key={link.href} className={styles.link} href={link.href}>
                {link.label}
              </a>
            ))}
          </div>
          <p className={styles.footerMeta}>
            Looking for a direct contact address? Email{" "}
            <a
              className={styles.contact}
              href="mailto:contact@aura-historia.com"
            >
              contact@aura-historia.com
            </a>
            .
          </p>
        </footer>
      </div>
    </div>
  );
}
