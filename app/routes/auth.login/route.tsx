import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return { errors: loginErrorMessage(await login(request)) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  return { errors: loginErrorMessage(await login(request)) };
};

export default function AuthLogin() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors } = actionData || loaderData;

  return (
    <AppProvider embedded={false}>
      <s-page heading="Install Aura Historia Partner Connect">
        <s-section>
          <s-paragraph>
            Connect your Shopify catalog so Aura Historia can receive product
            create, update, and delete events through Amazon EventBridge.
          </s-paragraph>

          <Form method="post">
            <div style={{ display: "grid", gap: "1rem" }}>
              <s-text-field
                name="shop"
                label="Shop domain"
                details="your-store.myshopify.com"
                value={shop}
                onChange={(event) => setShop(event.currentTarget.value)}
                autocomplete="on"
                error={errors.shop}
              />
              <s-button type="submit">Continue</s-button>
            </div>
          </Form>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
