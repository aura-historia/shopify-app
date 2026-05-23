import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import {
  loadShopCredentials,
  saveShopCredentials,
  validateShopCredentialsFormData,
} from "../shop-credentials.server";
import { getShopify } from "../shopify.server";
import styles from "../styles/app-home.module.css";

const productTopics = ["products/create", "products/update", "products/delete"];

const complianceTopics = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
  "app/uninstalled",
];

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { session } = await getShopify(context).authenticate.admin(request);
  const credentials = await loadShopCredentials(
    context.cloudflare.env.KV,
    session.shop,
  );

  return {
    credentials,
    shop: session.shop,
    scopes:
      session.scope
        ?.split(",")
        .map((scope: string) => scope.trim())
        .filter(Boolean) ?? [],
  };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { session } = await getShopify(context).authenticate.admin(request);
  const validation = validateShopCredentialsFormData(await request.formData());

  if (!validation.isValid) {
    return {
      ...validation,
      saved: false,
    };
  }

  await saveShopCredentials(
    context.cloudflare.env.KV,
    session.shop,
    validation.values,
  );

  return {
    ...validation,
    saved: true,
  };
};

export default function AppIndex() {
  const { credentials, shop, scopes } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const values = actionData?.values ??
    credentials ?? { apiKey: "", shopId: "" };
  const isSubmitting = navigation.state === "submitting";
  const hasSavedCredentials = Boolean(credentials);

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Connected catalog</p>
          <h1 className={styles.heading}>
            Connect <span className={styles.shopName}>{shop}</span> to your Aura
            Historia backend.
          </h1>
          <p className={styles.lead}>
            Save the merchant-specific Aura Historia shop ID and API key inside
            the authenticated Shopify admin so this installation can be mapped
            to the correct external backend account.
          </p>
        </div>

        <aside className={styles.sidePanel}>
          <section className={styles.panelMuted}>
            <h2 className={styles.cardTitle}>Granted scope</h2>
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
              {hasSavedCredentials
                ? "The latest Aura Historia credentials are loaded from Cloudflare KV for this shop."
                : "This installation still needs its Aura Historia shop ID and API key before backend mapping is complete."}
            </p>
          </section>
        </aside>
      </section>

      <section className={styles.grid}>
        <article className={styles.panel}>
          <h2 className={styles.cardTitle}>
            Aura Historia backend credentials
          </h2>
          <p className={styles.cardBody}>
            Both values are required. The shop ID must be a UUID, and the API
            key must follow the format{" "}
            <code className={styles.inlineCode}>
              aurahistoria_[short key]_[long key]
            </code>
            .
          </p>
          <Form className={styles.form} method="post">
            <label className={styles.field} htmlFor="shopId">
              Aura Historia shop ID
              <input
                className={styles.input}
                id="shopId"
                name="shopId"
                type="text"
                autoComplete="off"
                defaultValue={values.shopId}
                placeholder="123e4567-e89b-12d3-a456-426614174000"
                required
                spellCheck={false}
              />
            </label>
            {actionData?.errors.shopId ? (
              <p className={styles.errorText}>{actionData.errors.shopId}</p>
            ) : null}
            <label className={styles.field} htmlFor="apiKey">
              Aura Historia API key
              <input
                className={styles.input}
                id="apiKey"
                name="apiKey"
                type="text"
                autoComplete="off"
                defaultValue={values.apiKey}
                placeholder="aurahistoria_partner_verylongsecretkey"
                required
                spellCheck={false}
              />
            </label>
            {actionData?.errors.apiKey ? (
              <p className={styles.errorText}>{actionData.errors.apiKey}</p>
            ) : null}
            <p className={styles.fieldHint}>
              The saved values stay inside this authenticated embedded app and
              are stored per shop in Cloudflare KV.
            </p>
            {actionData?.saved ? (
              <p className={styles.successText}>
                Configuration saved for {shop}.
              </p>
            ) : null}
            <button className={styles.primaryButton} type="submit">
              {isSubmitting ? "Saving…" : "Save configuration"}
            </button>
          </Form>
        </article>

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
          <h2 className={styles.cardTitle}>Support and policies</h2>
          <div className={styles.linkRow}>
            <a className={styles.link} href="https://aura-historia.com">
              Main website
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
