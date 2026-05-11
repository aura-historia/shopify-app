import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

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
    <s-page heading="Aura Historia Partner Connect">
      <s-section heading="Status">
        <s-paragraph>
          The app is installed for <code>{shop}</code>.
        </s-paragraph>
        <s-paragraph>
          Shopify sends product create, update, and delete events to Aura
          Historia through Amazon EventBridge.
        </s-paragraph>
      </s-section>

      <s-section heading="Permissions">
        <s-paragraph>
          The app requests the minimum Shopify scope needed to observe product
          lifecycle changes.
        </s-paragraph>
        <s-unordered-list>
          {scopes.length > 0 ? (
            scopes.map((scope) => (
              <s-list-item key={scope}>{scope}</s-list-item>
            ))
          ) : (
            <s-list-item>read_products</s-list-item>
          )}
        </s-unordered-list>
      </s-section>

      <s-section heading="Public app compliance">
        <s-paragraph>
          Mandatory Shopify compliance webhooks are configured for public app
          distribution, and product events are delivered to the Aura Historia
          AWS integration.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
