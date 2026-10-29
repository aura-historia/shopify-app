import type { AppLoadContext } from "react-router";
import { getShopifyWebhook } from "../shopify.server";
import { SHIPPING_API_VERSION } from "./model";
import { shopCoordinator } from "./runtime.server";

export const SHIPPING_TOPICS = [
  "PROFILES_CREATE",
  "PROFILES_UPDATE",
  "PROFILES_DELETE",
  // Market-driven shops keep merchant shipping in Markets. Shopify does not
  // document which shipping edits update a market; periodic reads cover them.
  "MARKETS_CREATE",
  "MARKETS_UPDATE",
  "MARKETS_DELETE",
  "APP_SCOPES_UPDATE",
] as const;
export interface ShippingHint {
  topic: (typeof SHIPPING_TOPICS)[number];
  deliveryId: string;
  // The profile or market a notification names; scope changes name none.
  resourceId?: string;
}

export function hintResource(topic: ShippingHint["topic"]) {
  return topic.startsWith("PROFILES_")
    ? "DeliveryProfile"
    : topic.startsWith("MARKETS_")
      ? "Market"
      : null;
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
  const resource = hintResource(topic as ShippingHint["topic"]);
  let resourceId: string | undefined;
  if (resource) {
    // Do not round numeric identities or accept contradictory metadata.
    const id =
      (typeof body.id === "number" && Number.isSafeInteger(body.id)) ||
      typeof body.id === "string"
        ? String(body.id)
        : undefined;
    if (body.id !== undefined && id === undefined)
      return new Response(null, { status: 400 });
    // Market payloads carry only the numeric ID; profile payloads the GID.
    resourceId = String(
      body.admin_graphql_api_id ??
        (resource === "Market" && id ? `gid://shopify/Market/${id}` : ""),
    );
    if (
      !new RegExp(`^gid://shopify/${resource}/[1-9]\\d*$`).test(resourceId) ||
      (id !== undefined && id !== resourceId.split("/").at(-1))
    )
      return new Response(null, { status: 400 });
  }
  try {
    await shopCoordinator(context, shop).admitShippingHint(shop, {
      topic: topic as ShippingHint["topic"],
      deliveryId,
      resourceId,
    });
    return new Response(null, { status: 200 });
  } catch {
    // Shopify must retry if the durable commit or RPC reply was lost.
    return new Response(null, { status: 503 });
  }
}
