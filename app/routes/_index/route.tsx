import type { LoaderFunctionArgs } from "react-router";
import { Form, redirect } from "react-router";
import styles from "../../styles/public-page.module.css";

const legalLinks = [
  { href: "https://aura-historia.com/privacy", label: "Privacy" },
  { href: "https://aura-historia.com/imprint", label: "Imprint" },
  {
    href: "https://aura-historia.com/terms-and-conditions",
    label: "Terms & conditions",
  },
];

const productTopics = [
  {
    name: "products/create",
    description: "New catalog entries are forwarded to Aura Historia.",
  },
  {
    name: "products/update",
    description: "Product edits reach Aura Historia without polling.",
  },
  {
    name: "products/delete",
    description: "Catalog removals are broadcast to the downstream pipeline.",
  },
];

const complianceTopics = [
  {
    name: "customers/data_request",
    description: "Mandatory public-app compliance webhook subscription.",
  },
  {
    name: "customers/redact",
    description: "Mandatory public-app compliance webhook subscription.",
  },
  {
    name: "shop/redact",
    description: "Mandatory public-app compliance webhook subscription.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
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
              Aura Historia gives antique merchants and collectors a quieter,
              more authoritative way to track catalog changes and market
              movement.
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
            <span className={styles.tag}>Public app · EventBridge</span>
            <h1 className={styles.title}>
              Connect Shopify product changes to Aura Historia.
            </h1>
            <p className={styles.lead}>
              When merchants install the app from Shopify, Shopify provides the
              store context for us. Product create, update, and delete events
              then flow to Aura Historia through Amazon EventBridge with the
              minimum required Shopify access.
            </p>

            <div className={styles.buttonRow}>
              <a
                className={styles.primaryAction}
                href="https://aura-historia.com"
              >
                Visit aura-historia.com
              </a>
              <a className={styles.secondaryAction} href="#manual-install">
                Continue with store domain
              </a>
            </div>

            <div className={styles.grid}>
              <article className={styles.surfaceCard}>
                <h2 className={styles.cardTitle}>Best-practice install flow</h2>
                <p className={styles.cardBody}>
                  Merchants usually should not type a{" "}
                  <strong>myshopify.com</strong> domain. Shopify App Store and
                  Shopify admin launches provide the <strong>shop</strong> and{" "}
                  <strong>host</strong> query parameters, and this app uses that
                  context automatically.
                </p>
              </article>
              <article className={styles.surfaceCardStrong}>
                <h2 className={styles.cardTitle}>Product lifecycle events</h2>
                <ul className={styles.topicList}>
                  {productTopics.map((topic) => (
                    <li key={topic.name} className={styles.topicItem}>
                      <span className={styles.topicName}>{topic.name}</span>
                      <span className={styles.topicDescription}>
                        {topic.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </article>
            </div>
          </section>

          <aside className={styles.supportPanel}>
            <section className={styles.surfaceCardStrong}>
              <h2 className={styles.cardTitle}>
                Mandatory public-app subscriptions
              </h2>
              <ul className={styles.topicList}>
                {complianceTopics.map((topic) => (
                  <li key={topic.name} className={styles.topicItem}>
                    <span className={styles.topicName}>{topic.name}</span>
                    <span className={styles.topicDescription}>
                      {topic.description}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className={styles.surfaceCard}>
              <h2 className={styles.cardTitle}>Review and support</h2>
              <p className={styles.cardBody}>
                Aura Historia keeps its public policies and direct contact
                details visible here so Shopify App Store review is simple for
                merchants and reviewers.
              </p>
              <div className={styles.footerLinks}>
                {legalLinks.map((link) => (
                  <a key={link.href} className={styles.link} href={link.href}>
                    {link.label}
                  </a>
                ))}
              </div>
              <p className={styles.footerMeta}>
                For review questions, merchant support, or legal requests,
                contact{" "}
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

        <section id="manual-install" className={styles.manualPanel}>
          <p className={styles.cardTitle}>Manual fallback</p>
          <h2 className={styles.manualTitle}>
            Opened this URL outside Shopify?
          </h2>
          <p className={styles.manualText}>
            If Shopify did not send your store context, enter your permanent
            <strong> myshopify.com </strong>
            domain to continue with approval. This is a fallback, not the
            primary install path for a public App Store app.
          </p>
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label} htmlFor="shop">
              Shop domain
              <input
                className={styles.input}
                id="shop"
                name="shop"
                type="text"
                autoComplete="on"
                placeholder="your-store.myshopify.com"
              />
            </label>
            <p className={styles.fieldHint}>
              Use the permanent shop domain. Installs launched from Shopify
              normally skip this field because Shopify provides the shop and
              host query parameters automatically.
            </p>
            <button className={styles.primaryAction} type="submit">
              Continue to approval
            </button>
          </Form>
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
