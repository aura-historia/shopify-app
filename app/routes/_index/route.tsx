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
      "Mandatory public-app webhooks stay visible for review and cleanup.",
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
          "Handled by this app so stored Shopify sessions are removed.",
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
              Shopify product updates for Aura Historia.
            </h1>
            <p className={styles.lead}>
              Most merchants never need this page. Shopify usually opens the app
              with the store context already attached, and this app quietly
              forwards the relevant Shopify data to Aura Historia.
            </p>

            <div className={styles.buttonRow}>
              <a
                className={styles.primaryAction}
                href="https://aura-historia.com/partners/shopify"
              >
                Further information
              </a>
              <a className={styles.secondaryAction} href="#manual-install">
                Continue with store domain
              </a>
            </div>

            <div className={styles.grid}>
              <article className={styles.surfaceCard}>
                <h2 className={styles.cardTitle}>Install flow</h2>
                <p className={styles.cardBody}>
                  Shopify App Store and Shopify admin launches normally provide
                  the <strong>shop</strong> and <strong>host</strong> query
                  parameters automatically. Manual domain entry remains here
                  only as a fallback.
                </p>
              </article>
              <article className={styles.surfaceCardStrong}>
                <h2 className={styles.cardTitle}>What merchants configure</h2>
                <p className={styles.cardBody}>
                  After install, the embedded app focuses on the Aura Historia
                  shop ID and API key for the current Shopify shop.
                </p>
              </article>
            </div>
          </section>

          <aside className={styles.supportPanel}>
            <section className={styles.surfaceCardStrong}>
              <h2 className={styles.cardTitle}>Why this page exists</h2>
              <p className={styles.cardBody}>
                It keeps the fallback install path, review links, and a concise
                summary of the Shopify data access visible in one place.
              </p>
            </section>

            <section className={styles.surfaceCard}>
              <h2 className={styles.cardTitle}>
                Review, policies, and support
              </h2>
              <p className={styles.cardBody}>
                Aura Historia keeps its website, policy links, further
                information, and direct contact details visible here for
                merchants and Shopify reviewers.
              </p>
              <div className={styles.footerLinks}>
                <a
                  className={styles.link}
                  href="https://aura-historia.com/partners/shopify"
                >
                  Further information
                </a>
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

        <section id="manual-install" className={styles.manualPanel}>
          <p className={styles.cardTitle}>Manual fallback</p>
          <h2 className={styles.manualTitle}>
            Opened this URL outside Shopify?
          </h2>
          <p className={styles.manualText}>
            If Shopify did not send the store context, enter the permanent
            <strong> myshopify.com </strong>
            domain to continue with approval. This remains a fallback, not the
            normal install path.
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
              normally skip this field because Shopify provides the context
              automatically.
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
