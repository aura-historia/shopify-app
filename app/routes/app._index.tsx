import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import styles from "../styles/app-home.module.css";

const productTopics = ["products/create", "products/update", "products/delete"];

const complianceTopics = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
  "app/uninstalled",
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  return {
    shop: session.shop,
    scopes:
      session.scope
        ?.split(",")
        .map((scope) => scope.trim())
        .filter(Boolean) ?? [],
  };
};

export default function AppIndex() {
  const { shop, scopes } = useLoaderData<typeof loader>();

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Connected catalog</p>
          <h1 className={styles.heading}>
            Aura Historia is actively listening for product lifecycle changes
            from <span className={styles.shopName}>{shop}</span>.
          </h1>
          <p className={styles.lead}>
            Whenever products are created, updated, or deleted, Shopify forwards
            the event to Aura Historia through Amazon EventBridge with the
            minimum scope needed for catalog visibility.
          </p>
        </div>

        <aside className={styles.sidePanel}>
          <section className={styles.panelMuted}>
            <h2 className={styles.cardTitle}>Granted scope</h2>
            <div className={styles.tagList}>
              {(scopes.length > 0 ? scopes : ["read_products"]).map((scope) => (
                <span key={scope} className={styles.tag}>
                  {scope}
                </span>
              ))}
            </div>
          </section>

          <section className={styles.panel}>
            <h2 className={styles.cardTitle}>Support and policies</h2>
            <div className={styles.linkRow}>
              <a className={styles.link} href="https://aura-historia.com">
                Main website
              </a>
              <a
                className={styles.link}
                href="https://aura-historia.com/privacy"
              >
                Privacy
              </a>
              <a
                className={styles.link}
                href="https://aura-historia.com/imprint"
              >
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
          </section>
        </aside>
      </section>

      <section className={styles.grid}>
        <article className={styles.panel}>
          <h2 className={styles.cardTitle}>Product event flow</h2>
          <ul className={styles.topicList}>
            {productTopics.map((topic) => (
              <li key={topic} className={styles.topicItem}>
                <span className={styles.topicName}>{topic}</span>
                <span className={styles.topicDescription}>
                  Delivered to the configured Aura Historia EventBridge partner
                  source.
                </span>
              </li>
            ))}
          </ul>
        </article>

        <article className={styles.panelMuted}>
          <h2 className={styles.cardTitle}>Public-app compliance</h2>
          <ul className={styles.topicList}>
            {complianceTopics.map((topic) => (
              <li key={topic} className={styles.topicItem}>
                <span className={styles.topicName}>{topic}</span>
                <span className={styles.topicDescription}>
                  Preserved so App Store review and uninstall cleanup remain in
                  place.
                </span>
              </li>
            ))}
          </ul>
        </article>

        <article className={styles.panel}>
          <h2 className={styles.cardTitle}>Operational note</h2>
          <p className={styles.cardBody}>
            Localhost development keeps the uninstall cleanup webhook on the
            deployed app URL, while product and compliance topics continue to be
            delivered through EventBridge.
          </p>
        </article>
      </section>
    </div>
  );
}
