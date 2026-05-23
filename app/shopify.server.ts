import "@shopify/shopify-api/adapters/cf-worker";
import type { KVNamespace } from "@cloudflare/workers-types";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { KVSessionStorage } from "@shopify/shopify-app-session-storage-kv";
import type { AppLoadContext } from "react-router";

export interface CloudflareShopifyEnv {
  KV: KVNamespace;
  SCOPES?: string;
  SHOPIFY_API_KEY?: string;
  SHOPIFY_API_SECRET?: string;
  SHOPIFY_APP_URL?: string;
  SHOP_CUSTOM_DOMAIN?: string;
}

type GraphqlResponse = {
  json: () => Promise<unknown>;
};

type AdminGraphqlClient = {
  graphql: (
    operation: string,
    options?: { variables?: Record<string, string> },
  ) => Promise<GraphqlResponse>;
};

type GraphqlUserError = {
  message: string;
};

type WebhookSubscriptionsQueryResult = {
  data?: {
    webhookSubscriptions?: {
      edges?: Array<{
        node?: {
          callbackUrl?: string | null;
        } | null;
      }>;
    };
  };
};

type WebhookSubscriptionCreateResult = {
  data?: {
    webhookSubscriptionCreate?: {
      userErrors?: GraphqlUserError[];
    };
  };
};

type BulkOperationRunQueryResult = {
  data?: {
    bulkOperationRunQuery?: {
      bulkOperation?: {
        id?: string | null;
      } | null;
      userErrors?: GraphqlUserError[];
    };
  };
};

const apiVersion = ApiVersion.April26;
const shopifyCache = new Map<string, ReturnType<typeof shopifyApp>>();
export const BULK_OPERATION_FINISH_WEBHOOK_URL =
  "https://example.com/shopify/bulk-operations/finish";
export const PRODUCT_BULK_BACKFILL_QUERY = `{
  products {
    edges {
      node {
        id
        title
        handle
        status
        createdAt
        updatedAt
      }
    }
  }
}`;

const EXISTING_BULK_OPERATION_FINISH_WEBHOOKS_QUERY = `#graphql
  query ExistingBulkOperationFinishWebhooks {
    webhookSubscriptions(first: 50, topics: [BULK_OPERATIONS_FINISH]) {
      edges {
        node {
          callbackUrl
        }
      }
    }
  }
`;

const CREATE_BULK_OPERATION_FINISH_WEBHOOK_MUTATION = `#graphql
  mutation CreateBulkOperationFinishWebhook($callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: BULK_OPERATIONS_FINISH
      webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
    ) {
      userErrors {
        message
      }
    }
  }
`;

const START_PRODUCT_BULK_BACKFILL_MUTATION = `#graphql
  mutation StartProductBulkBackfill($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id
      }
      userErrors {
        message
      }
    }
  }
`;

function getUserErrorMessage(userErrors: GraphqlUserError[] | undefined) {
  return userErrors?.map((userError) => userError.message).join("; ");
}

async function ensureBulkOperationFinishWebhook(admin: AdminGraphqlClient) {
  const existingWebhooksResponse = await admin.graphql(
    EXISTING_BULK_OPERATION_FINISH_WEBHOOKS_QUERY,
  );
  const existingWebhooksBody =
    (await existingWebhooksResponse.json()) as WebhookSubscriptionsQueryResult;
  const callbackUrls =
    existingWebhooksBody.data?.webhookSubscriptions?.edges
      ?.map((edge) => edge.node?.callbackUrl)
      .filter((callbackUrl): callbackUrl is string => Boolean(callbackUrl)) ??
    [];

  if (callbackUrls.includes(BULK_OPERATION_FINISH_WEBHOOK_URL)) {
    return;
  }

  const createWebhookResponse = await admin.graphql(
    CREATE_BULK_OPERATION_FINISH_WEBHOOK_MUTATION,
    {
      variables: {
        callbackUrl: BULK_OPERATION_FINISH_WEBHOOK_URL,
      },
    },
  );
  const createWebhookBody =
    (await createWebhookResponse.json()) as WebhookSubscriptionCreateResult;
  const userErrorMessage = getUserErrorMessage(
    createWebhookBody.data?.webhookSubscriptionCreate?.userErrors,
  );

  if (userErrorMessage) {
    throw new Error(
      `Failed to create bulk_operations/finish webhook: ${userErrorMessage}`,
    );
  }
}

export async function startInstallationProductBackfill(
  admin: AdminGraphqlClient,
  shop: string,
) {
  try {
    await ensureBulkOperationFinishWebhook(admin);

    const backfillResponse = await admin.graphql(
      START_PRODUCT_BULK_BACKFILL_MUTATION,
      {
        variables: {
          query: PRODUCT_BULK_BACKFILL_QUERY,
        },
      },
    );
    const backfillBody =
      (await backfillResponse.json()) as BulkOperationRunQueryResult;
    const userErrorMessage = getUserErrorMessage(
      backfillBody.data?.bulkOperationRunQuery?.userErrors,
    );

    if (userErrorMessage) {
      throw new Error(`Failed to start product backfill: ${userErrorMessage}`);
    }

    console.info("Started installation product backfill", {
      bulkOperationId:
        backfillBody.data?.bulkOperationRunQuery?.bulkOperation?.id ?? null,
      shop,
      webhookTarget: BULK_OPERATION_FINISH_WEBHOOK_URL,
    });
  } catch (error) {
    console.error("Failed to initialize installation product backfill", {
      error,
      shop,
      webhookTarget: BULK_OPERATION_FINISH_WEBHOOK_URL,
    });
  }
}

function getEnv(context: AppLoadContext): CloudflareShopifyEnv {
  return context.cloudflare.env;
}

function getResolvedConfig(env: CloudflareShopifyEnv) {
  return {
    apiKey: env.SHOPIFY_API_KEY ?? process.env.SHOPIFY_API_KEY ?? "",
    apiSecretKey:
      env.SHOPIFY_API_SECRET ?? process.env.SHOPIFY_API_SECRET ?? "",
    appUrl: env.SHOPIFY_APP_URL ?? process.env.SHOPIFY_APP_URL ?? "",
    scopes: getScopes(env.SCOPES ?? process.env.SCOPES),
    customShopDomain:
      env.SHOP_CUSTOM_DOMAIN ?? process.env.SHOP_CUSTOM_DOMAIN ?? "",
  };
}

function getCacheKey(env: CloudflareShopifyEnv) {
  const config = getResolvedConfig(env);

  return [
    config.apiKey,
    config.apiSecretKey,
    config.appUrl,
    config.scopes.join(","),
    config.customShopDomain,
  ].join("|");
}

function getScopes(scopes: string | undefined) {
  return (
    scopes
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean) ?? []
  );
}

export function getShopify(context: AppLoadContext) {
  const env = getEnv(context);
  const config = getResolvedConfig(env);
  const cacheKey = getCacheKey(env);
  const cached = shopifyCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const shopify = shopifyApp({
    apiKey: config.apiKey,
    apiSecretKey: config.apiSecretKey,
    apiVersion,
    scopes: config.scopes,
    appUrl: config.appUrl,
    authPathPrefix: "/auth",
    sessionStorage: new KVSessionStorage(env.KV),
    distribution: AppDistribution.AppStore,
    future: {
      expiringOfflineAccessTokens: true,
    },
    hooks: {
      afterAuth: async ({ admin, session }) => {
        await startInstallationProductBackfill(admin, session.shop);
      },
    },
    ...(config.customShopDomain
      ? { customShopDomains: [config.customShopDomain] }
      : {}),
  });

  shopifyCache.set(cacheKey, shopify);

  return shopify;
}

export function getShopifyApiKey(context: AppLoadContext) {
  return getResolvedConfig(getEnv(context)).apiKey;
}
