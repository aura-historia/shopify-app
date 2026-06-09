import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import styles from "../../styles/public-page.module.css";

const legalLinks = [
  { href: "https://aura-historia.com/privacy", label: "Privacy" },
  { href: "https://aura-historia.com/imprint", label: "Imprint" },
  {
    href: "https://aura-historia.com/terms-and-conditions",
    label: "Terms & conditions",
  },
];

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
    description:
      "Mandatory public-app privacy and uninstall webhooks are declared.",
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
          "Handled by this app so stored sessions and connection data are removed.",
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
        description:
          "Used to associate the Shopify install with the right shop.",
      },
      {
        name: "currency",
        description: "Used so partner-side pricing stays aligned with Shopify.",
      },
    ],
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const shop = url.searchParams.get("shop");

  if (shop) {
    // Shopify admin always includes `host` (plus `embedded=1` and `id_token`)
    // when opening the app in the embedded iframe.  Route those directly to
    // /app so authenticate.admin() can run the token-exchange flow without
    // hitting the login page inside the iframe.
    //
    // App Store install links only carry `shop` (no `host`). Route those to
    // /auth/login so shopify.login() can initiate the OAuth install redirect.
    if (url.searchParams.get("host")) {
      throw redirect(`/app?${url.searchParams.toString()}`);
    }
    throw redirect(`/auth/login?${url.searchParams.toString()}`);
  }

  return null;
};

export default function MarketingIndex() {
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
              Aura Historia unites the World of Antiques and Art. Are you in?
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
            <span className={styles.tag}>Aura Historia x Shopify</span>
            <h1 className={styles.title}>
              Aura Historia Partner Connect for Shopify.
            </h1>
            <p className={styles.lead}>
              This minimal public Shopify app connects an approved Shopify store
              with Aura Historia. Installation starts from the Shopify App Store
              or Shopify Admin so Shopify can provide the store context and
              OAuth approval automatically.
            </p>

            <div className={styles.buttonRow}>
              <a
                className={styles.primaryAction}
                href="https://aura-historia.com/partners/shopify"
              >
                Learn about the integration
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

        <section className={styles.grid}>
          {accessSections.map((section, index) => (
            <article
              key={section.title}
              className={
                index === 1 ? styles.surfaceCardStrong : styles.surfaceCard
              }
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
        </section>

        <section className={styles.manualPanel}>
          <p className={styles.cardTitle}>Installation starts in Shopify</p>
          <h2 className={styles.manualTitle}>
            Use the App Store or Shopify Admin to install.
          </h2>
          <p className={styles.manualText}>
            For merchant security, this public page does not collect store
            domains. When Shopify includes the store context, Aura Historia
            Partner Connect redirects directly to Shopify OAuth approval and
            then to the embedded app UI.
          </p>
          <div className={styles.buttonRow}>
            <a
              className={styles.primaryAction}
              href="https://aura-historia.com/partners/shopify"
            >
              View setup notes
            </a>
            <a
              className={styles.secondaryAction}
              href="mailto:contact@aura-historia.com"
            >
              Email support
            </a>
          </div>
        </section>

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
            Need a direct contact for Shopify review or merchant support? Email
            <a
              className={styles.contact}
              href="mailto:contact@aura-historia.com"
            >
              {" "}
              contact@aura-historia.com
            </a>
            .
          </p>
        </footer>
      </div>
    </div>
  );
}
