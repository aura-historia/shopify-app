import type { ActionFunctionArgs } from "react-router";
import { receiveShippingWebhook } from "../shipping/webhooks.server";

export const action = ({ request, context }: ActionFunctionArgs) =>
  receiveShippingWebhook(request, context);
