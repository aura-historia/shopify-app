import type { LoaderFunctionArgs } from "react-router";
import { Form, redirect } from "react-router";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function MarketingIndex() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>
          Connect Shopify product changes to Aura Historia
        </h1>
        <p className={styles.text}>
          Install the app to stream product create, update, and delete events
          from your shop to Aura Historia over Amazon EventBridge.
        </p>
        <Form className={styles.form} method="post" action="/auth/login">
          <label className={styles.label}>
            <span>Shop domain</span>
            <input
              className={styles.input}
              type="text"
              name="shop"
              autoComplete="on"
              placeholder="your-store.myshopify.com"
            />
            <span>
              Use your permanent <code>.myshopify.com</code> domain.
            </span>
          </label>
          <button className={styles.button} type="submit">
            Install app
          </button>
        </Form>
        <ul className={styles.list}>
          <li>
            <strong>Automatic product sync.</strong> Shopify pushes product
            lifecycle events without polling.
          </li>
          <li>
            <strong>Minimal access.</strong> The app only requests the
            <code> read_products </code>
            scope.
          </li>
          <li>
            <strong>Public app ready.</strong> Mandatory compliance webhooks are
            subscribed for App Store review.
          </li>
        </ul>
      </div>
    </div>
  );
}
