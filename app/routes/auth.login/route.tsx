import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { getShopify } from "../../shopify.server";
import styles from "../../styles/public-page.module.css";
import { loginErrorMessage } from "./error.server";

const legalLinks = [
  { href: "https://aura-historia.com/privacy", label: "Privacy" },
  { href: "https://aura-historia.com/imprint", label: "Imprint" },
  {
    href: "https://aura-historia.com/terms-and-conditions",
    label: "Terms & conditions",
  },
];

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  return {
    errors: loginErrorMessage(await getShopify(context).login(request)),
  };
};

export default function AuthLogin() {
  const { errors } = useLoaderData<typeof loader>();

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
              Shopify provides the store context for App Store installs and
              embedded Admin launches.
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
            <span className={styles.tag}>Shopify installation</span>
            <h1 className={`${styles.title} ${styles.wideTitle}`}>
              Start installation from Shopify.
            </h1>
            <p className={styles.lead}>
              Aura Historia Partner Connect does not collect store domains on
              this public page. Open the app from the Shopify App Store, Shopify
              Admin, or the Partner Dashboard install action so Shopify can send
              the required store context and begin OAuth approval.
            </p>

            {errors.shop ? (
              <p className={styles.errorText}>{errors.shop}</p>
            ) : null}

            <div className={styles.buttonRow}>
              <a
                className={styles.primaryAction}
                href="https://aura-historia.com/partners/shopify"
              >
                View setup notes
              </a>
              <a
                className={styles.secondaryAction}
                href="https://aura-historia.com"
              >
                Visit aura-historia.com
              </a>
            </div>
          </section>

          <aside className={styles.supportPanel}>
            <section className={styles.surfaceCardStrong}>
              <h2 className={styles.cardTitle}>After approval</h2>
              <p className={styles.cardBody}>
                Once Shopify completes approval, the app continues directly into
                the Aura Historia OAuth flow and then returns the merchant to
                the embedded Shopify admin app with a clear status.
              </p>
            </section>

            <section className={styles.surfaceCard}>
              <h2 className={styles.cardTitle}>Review and support</h2>
              <div className={styles.footerLinks}>
                {legalLinks.map((link) => (
                  <a key={link.href} className={styles.link} href={link.href}>
                    {link.label}
                  </a>
                ))}
              </div>
              <p className={styles.footerMeta}>
                Need help with installation, support, or Shopify App Store
                review? Email{" "}
                <a
                  className={styles.contact}
                  href="mailto:contact@aura-historia.com"
                >
                  contact@aura-historia.com
                </a>
                .
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
            You can also reach Aura Historia directly at{" "}
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
