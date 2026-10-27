import type { AppLoadContext } from "react-router";
import { PRODUCT_LISTINGS_SCOPE } from "../catalog.server";
import { queueCatalogImport } from "../catalog-import.server";
import { getShopifyWebhook } from "../shopify.server";
import { SHIPPING_API_VERSION } from "./model";
import { shopCoordinator } from "./runtime.server";

export const SHIPPING_TOPICS = [
  "PROFILES_CREATE",
  "PROFILES_UPDATE",
  "PROFILES_DELETE",
  "APP_SCOPES_UPDATE",
] as const;
export interface ShippingHint {
  topic: (typeof SHIPPING_TOPICS)[number];
  deliveryId: string;
  profileId?: string;
}

// Bound the stream before passing its original bytes to Shopify's HMAC verifier.
// Content-Length alone is insufficient for chunked requests.
async function boundedRequest(request: Request): Promise<Request> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16_384) {
          await reader.cancel();
          throw new Response(null, { status: 413 });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
  });
}

function grantsProductListings(body: Record<string, unknown>) {
  const has = (scopes: unknown) =>
    Array.isArray(scopes) &&
    scopes.some(
      (scope) =>
        scope === PRODUCT_LISTINGS_SCOPE || scope === "write_product_listings",
    );
  return has(body.current) && !has(body.previous);
}

export async function receiveShippingWebhook(
  request: Request,
  context: AppLoadContext,
) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const original = await boundedRequest(request);
  const { shop, topic, payload, session } =
    await getShopifyWebhook(context).authenticate.webhook(original);
  if (
    !SHIPPING_TOPICS.includes(topic as ShippingHint["topic"]) ||
    original.headers.get("X-Shopify-API-Version") !== SHIPPING_API_VERSION
  )
    return new Response(null, { status: 400 });
  // Authentication does not require an extant session for uninstalled shops.
  // Shipping hints must belong to an installed shop; they never bind a source.
  if (!session || session.shop !== shop || session.isOnline)
    return new Response(null, { status: 200 });
  const deliveryId = original.headers.get("X-Shopify-Webhook-Id");
  if (!deliveryId || !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId))
    return new Response(null, { status: 400 });
  const body = payload as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body))
    return new Response(null, { status: 400 });
  let profileId: string | undefined;
  if (topic !== "APP_SCOPES_UPDATE") {
    profileId = String(body.admin_graphql_api_id ?? "");
    if (!/^gid:\/\/shopify\/DeliveryProfile\/[1-9]\d*$/.test(profileId))
      return new Response(null, { status: 400 });
    // Do not round numeric identities or accept contradictory metadata.
    if (
      body.id !== undefined &&
      String(body.id) !== profileId.split("/").at(-1)
    )
      return new Response(null, { status: 400 });
  }
  try {
    await shopCoordinator(context, shop).admitShippingHint(shop, {
      topic: topic as ShippingHint["topic"],
      deliveryId,
      profileId,
    });
    if (topic === "APP_SCOPES_UPDATE" && grantsProductListings(body))
      // Existing installations recover through Shopify's scope update: the
      // first grant of channel listing access starts the filtered import.
      context.cloudflare.ctx.waitUntil(queueCatalogImport(context, shop));
    return new Response(null, { status: 200 });
  } catch {
    // Shopify must retry if the durable commit or RPC reply was lost.
    return new Response(null, { status: 503 });
  }
}
