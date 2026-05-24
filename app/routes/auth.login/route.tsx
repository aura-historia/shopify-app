import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData } from "react-router";
import {
  getInstallCredentialsFromSearchParams,
  getPathWithSearchParams,
  hasInstallCredentialsSearchParams,
  serializeInstallCredentialsCookie,
  stripInstallCredentialsSearchParams,
} from "../../install-credentials.server";
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
  const url = new URL(request.url);
  const installCredentials = getInstallCredentialsFromSearchParams(
    url.searchParams,
  );

  if (hasInstallCredentialsSearchParams(url.searchParams)) {
    const headers = new Headers();
    if (installCredentials) {
      headers.append(
        "Set-Cookie",
        await serializeInstallCredentialsCookie(installCredentials),
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

  return {
    errors: loginErrorMessage(await getShopify(context).login(request)),
  };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  return {
    errors: loginErrorMessage(await getShopify(context).login(request)),
  };
};

export default function AuthLogin() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const { errors } = actionData || loaderData;

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
              This page is only a fallback for merchants who opened the app URL
              directly without Shopify sending the store context.
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
            <span className={styles.tag}>Manual fallback</span>
            <h1 className={`${styles.title} ${styles.wideTitle}`}>
              Continue with your Shopify store domain.
            </h1>
            <p className={styles.lead}>
              Public App Store installs usually continue automatically because
              Shopify provides the store context in the query string. Use this
              page only when you need to resume approval from a direct app URL.
            </p>

            <Form className={styles.form} method="post">
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
                Use your permanent shop domain. We will hand the request back to
                Shopify so the merchant can approve installation.
              </p>
              {errors.shop ? (
                <p className={styles.errorText}>{errors.shop}</p>
              ) : null}
              <div className={styles.buttonRow}>
                <button className={styles.primaryAction} type="submit">
                  Continue to Shopify approval
                </button>
                <a
                  className={styles.secondaryAction}
                  href="https://aura-historia.com"
                >
                  Visit aura-historia.com
                </a>
              </div>
            </Form>
          </section>

          <aside className={styles.supportPanel}>
            <section className={styles.surfaceCardStrong}>
              <h2 className={styles.cardTitle}>After approval</h2>
              <p className={styles.cardBody}>
                Once Shopify completes approval, the app redirects to a success
                page with the next step back into Aura Historia and links to the
                main Aura Historia website.
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
