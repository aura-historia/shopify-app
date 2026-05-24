import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import type { GraphqlRequestFn } from "../backfill.server";
import { triggerBackfill } from "../backfill.server";
import {
  loadShopCredentials,
  saveShopCredentials,
  validateShopCredentialsFormData,
} from "../shop-credentials.server";
import { getShopify } from "../shopify.server";
import styles from "../styles/app-home.module.css";

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
      "Mandatory public-app webhooks stay in place for review and cleanup.",
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
        description: "Used so uninstall cleanup can remove stored sessions.",
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
        description: "Used to associate this installation with the right shop.",
      },
      {
        name: "currency",
        description: "Used so partner-side pricing stays aligned with Shopify.",
      },
    ],
  },
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
  const shopify = getShopify(context);
  const { session, admin } = await shopify.authenticate.admin(request);
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

  const apiBaseUrl =
    context.cloudflare.env.AURA_HISTORIA_API_BASE_URL ??
    process.env.AURA_HISTORIA_API_BASE_URL;

  if (apiBaseUrl) {
    const graphqlRequest: GraphqlRequestFn = async (query, variables) => {
      const response = await admin.graphql(query, { variables });
      return response.json();
    };

    context.cloudflare.ctx.waitUntil(
      triggerBackfill(
        graphqlRequest,
        context.cloudflare.env.KV,
        session.shop,
        validation.values.shopId,
        validation.values.apiKey,
        apiBaseUrl,
      ),
    );
  }

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
          <p className={styles.eyebrow}>Shopify partner connect</p>
          <h1 className={styles.heading}>
            Save this shop&apos;s Aura Historia credentials.
          </h1>
          <p className={styles.lead}>
            Use the shop ID and API key below to map this Shopify installation
            to the correct Aura Historia account.
          </p>
        </div>

        <aside className={styles.sidePanel}>
          <section className={styles.panelMuted}>
            <h2 className={styles.cardTitle}>Installed for</h2>
            <p className={styles.cardBody}>
              <span className={styles.shopName}>{shop}</span>
            </p>
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
                ? "The latest Aura Historia credentials are already loaded for this shop."
                : "This installation still needs its Aura Historia shop ID and API key."}
            </p>
          </section>
        </aside>
      </section>

      <section className={styles.panel}>
        <h2 className={styles.cardTitle}>Aura Historia credentials</h2>
        <p className={styles.cardBody}>
          Both values are required. The shop ID must be a UUID, and the API key
          must follow the format{" "}
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
            The saved values are stored per shop in Cloudflare KV.
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
      </section>

      <section className={styles.grid}>
        {accessSections.map((section, index) => (
          <article
            key={section.title}
            className={index === 1 ? styles.panelMuted : styles.panel}
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

        <article className={styles.panel}>
          <h2 className={styles.cardTitle}>Further information and policies</h2>
          <div className={styles.linkRow}>
            <a className={styles.link} href="https://aura-historia.com">
              Main website
            </a>
            <a
              className={styles.link}
              href="https://aura-historia.com/partners/shopify"
            >
              Further information
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
