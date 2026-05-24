import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import {
  clearInstallCredentialsCookie,
  getInstallCredentialsFromSearchParams,
  getPathWithSearchParams,
  hasInstallCredentialsSearchParams,
  readInstallCredentialsCookie,
  serializeInstallCredentialsCookie,
  stripInstallCredentialsSearchParams,
} from "../install-credentials.server";
import {
  isValidAuraHistoriaApiKey,
  isValidShopId,
  loadShopCredentials,
  saveShopCredentials,
  validateShopCredentialsFormData,
} from "../shop-credentials.server";
import { getShopify } from "../shopify.server";
import styles from "../styles/app-home.module.css";

const supportLinks = [
  {
    href: "https://aura-historia.com",
    label: "Main website",
  },
  {
    href: "https://aura-historia.com/privacy",
    label: "Privacy",
  },
  {
    href: "https://aura-historia.com/terms-and-conditions",
    label: "Terms & conditions",
  },
];

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const { session } = await getShopify(context).authenticate.admin(request);
  const urlInstallCredentials = getInstallCredentialsFromSearchParams(
    url.searchParams,
  );

  if (hasInstallCredentialsSearchParams(url.searchParams)) {
    const headers = new Headers();
    if (urlInstallCredentials) {
      headers.append(
        "Set-Cookie",
        await serializeInstallCredentialsCookie(urlInstallCredentials),
      );
    }
    throw redirect(
      getPathWithSearchParams(
        url.pathname,
        stripInstallCredentialsSearchParams(url.searchParams),
      ),
      { headers },
    );
  }

  const cookieInstallCredentials = await readInstallCredentialsCookie(
    request.headers.get("Cookie"),
  );
  let credentials = await loadShopCredentials(
    context.cloudflare.env.KV,
    session.shop,
  );
  let autoSavedFromInstallLink = false;
  let installCredentialsNeedReview = false;

  if (cookieInstallCredentials) {
    const validInstallCredentials =
      isValidShopId(cookieInstallCredentials.shopId) &&
      isValidAuraHistoriaApiKey(cookieInstallCredentials.apiKey);

    if (validInstallCredentials) {
      const credentialsChanged =
        credentials?.shopId !== cookieInstallCredentials.shopId ||
        credentials?.apiKey !== cookieInstallCredentials.apiKey;

      if (credentialsChanged) {
        credentials = await saveShopCredentials(
          context.cloudflare.env.KV,
          session.shop,
          cookieInstallCredentials,
        );
      }

      autoSavedFromInstallLink = true;
    } else {
      installCredentialsNeedReview = true;
    }
  }

  const initialValues = cookieInstallCredentials ??
    credentials ?? { apiKey: "", shopId: "" };
  const headers = new Headers();

  if (cookieInstallCredentials) {
    headers.append("Set-Cookie", await clearInstallCredentialsCookie());
  }

  return data(
    {
      autoSavedFromInstallLink,
      credentials,
      initialValues,
      installCredentialsNeedReview,
      shop: session.shop,
    },
    { headers },
  );
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
  const {
    autoSavedFromInstallLink,
    credentials,
    initialValues,
    installCredentialsNeedReview,
    shop,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const values = actionData?.values ?? initialValues;
  const isSubmitting = navigation.state === "submitting";
  const hasSavedCredentials = Boolean(credentials);

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Embedded configuration</p>
          <h1 className={styles.heading}>
            Manage the Aura Historia credentials for{" "}
            <span className={styles.shopName}>{shop}</span>.
          </h1>
          <p className={styles.lead}>
            Save or update the Aura Historia shop ID and API key for this
            Shopify installation. You can review and edit the values here at any
            time.
          </p>
        </div>

        <aside className={styles.sidePanel}>
          <section className={styles.panel}>
            <h2 className={styles.cardTitle}>Configuration status</h2>
            <p className={styles.cardBody}>
              {hasSavedCredentials
                ? "Credentials are already stored for this shop. Saving again replaces the existing values."
                : "This shop still needs its Aura Historia shop ID and API key before the backend mapping is complete."}
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
            {autoSavedFromInstallLink ? (
              <p className={styles.successText}>
                Credentials from the install link were loaded and saved for{" "}
                {shop}. Review or edit them below if needed.
              </p>
            ) : null}
            {installCredentialsNeedReview ? (
              <p className={styles.fieldHint}>
                Credentials from the install link were loaded into the form but
                were not saved because one or both values need review.
              </p>
            ) : null}
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
          <h2 className={styles.cardTitle}>Support and policies</h2>
          <div className={styles.linkRow}>
            {supportLinks.map((link) => (
              <a key={link.href} className={styles.link} href={link.href}>
                {link.label}
              </a>
            ))}
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
