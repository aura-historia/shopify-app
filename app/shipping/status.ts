export const SHIPPING_PHASE_LABELS = {
  idle: "Ready to import",
  queued: "Queued",
  acquiring: "Reading Shopify settings",
  publishing: "Applying advertised terms",
  partial: "Partially applied",
  applied: "Applied",
  blocked: "Needs attention",
} as const;

export function shippingIssueMessage(code: string) {
  switch (code) {
    case "SHIPPING_PERMISSION_REQUIRED":
      return "Grant optional shipping access, then import again.";
    case "SHOPIFY_OFFLINE_ACCESS_REQUIRED":
      return "Reopen the Shopify app to renew access, then import again.";
    case "MARKET_DRIVEN_SHIPPING_UNSUPPORTED":
      return "This shop uses market-driven shipping. Importing that configuration is not supported yet.";
    case "UNSUPPORTED_SHOPIFY_SCHEMA":
    case "UNSUPPORTED_SHOPIFY_API_VERSION":
      return "This shop's shipping API is not supported by the importer.";
    case "AURA_HTTP_401":
    case "AURA_HTTP_403":
    case "FORBIDDEN":
      return "Reconnect Aura Historia to grant shipping read and write permissions, then import again.";
    case "SHIPPING_IMPORT_DEPENDENCY_MISSING":
      return "Some catalog listings are not available yet. Their shipping assignments will be retried automatically.";
    case "SHIPPING_RETRY_LIMIT_REACHED":
      return "Automatic retries have paused. Import again to resume pending work after resolving the connection or catalog issue.";
    case "SHIPPING_RETRY_RETENTION_REACHED":
      return "The pending request retention period ended. Import again to acquire current settings.";
    case "SHIPPING_CLEANUP_UNCONFIRMED":
      return "Removal of prior shipping assertions could not be confirmed. Reconnect and import current settings or contact support. Prior terms remain available until explicitly removed or their authority changes.";
    case "SHIPPING_LOCALLY_STOPPED":
      return "Shipping synchronization has stopped for this connection.";
    case "SHOPIFY_CHANGED_DURING_READ":
    case "RECONCILIATION_REQUIRED":
      return "Shipping settings changed during import. Import again to read the current configuration.";
    case "CONNECTION_CHANGED_REACQUIRE":
      return "The connection changed. Import again using the current connection.";
    case "ACQUISITION_LIMIT_EXCEEDED":
    case "AURA_POLICY_LIMIT_EXCEEDED":
      return "This configuration exceeds the supported import limits. Contact support.";
    case "UNSUPPORTED_CURRENCY":
    case "INEXACT_MINOR_UNITS":
    case "MONEY_OUT_OF_RANGE":
      return "Some advertised amounts cannot be represented exactly in the supported currencies.";
    default:
      return "Some shipping work could not finish. Pending work will retry; import again after resolving the configuration or contact support.";
  }
}

export function shippingLimitationMessage(code: string) {
  switch (code) {
    case "UNSUPPORTED_RATE_CONDITION":
      return "Weight and upper basket limits remain conditional.";
    case "EXTERNAL_RATES_REQUIRE_CHECKOUT":
      return "Carrier and app prices are calculated at checkout.";
    case "SHOPIFY_CHARGE_GROUP_BASIS_UNAVAILABLE":
      return "Static rate amounts are advertised, but their combined checkout charge depends on the cart and fulfillment groups.";
    case "UNSUPPORTED_RATE_PROVIDER":
      return "Some rate providers cannot be represented yet.";
    case "UNSUPPORTED_ORIGIN_OR_SELLING_PLAN_APPLICABILITY":
      return "Profiles with multiple origin groups, unrated origins or selling plans remain unasserted.";
    case "REST_OF_WORLD_UNRESOLVED":
      return "Rest-of-world destination coverage remains unresolved.";
    case "SUBDIVISION_MAPPING_UNAVAILABLE":
      return "Province-specific destination coverage remains unresolved.";
    case "MIXED_OR_UNKNOWN_MEMBERSHIP":
      return "Products with mixed or unknown variant membership do not inherit a shipping profile.";
    default:
      return "Some settings remain unasserted because they are not supported yet.";
  }
}
