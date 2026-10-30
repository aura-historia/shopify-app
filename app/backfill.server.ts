import {
  type CatalogImportError,
  type CatalogImportStatus,
  CHANNEL_PROVISIONING_ERRORS,
  CHANNEL_PUBLICATION_ERRORS,
  resolveChannelPublication,
} from "./catalog.server";
import {
  ensureAuraChannel,
  PUBLICATION_GID,
  readCatalogAccess,
} from "./channel.server";
import { CURRENCY_MINOR_UNITS } from "./currency";
import { createClient } from "./generated/api/client";
import {
  deleteAsyncPartnerProductListings,
  putAsyncPartnerProductListings,
  putShopifyListingSourceIngestionConfiguration,
} from "./generated/api/sdk.gen";
import type {
  AsyncProductListingBatchReport,
  CurrencyData,
  LanguageData,
  ListingAvailabilityData,
  PutShopifyListingSourceIngestionConfigurationData,
  UpsertProductListingData,
  WithdrawProductListingData,
} from "./generated/api/types.gen";
import { isValidListingSourceId } from "./shop-credentials.server";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;
const BACKFILL_CONTEXT_PREFIX = "aura-historia:backfill:";

// Supported catalog. The export lists every product of the store, not only
// those published to Aura, with all of its images and variants. A larger
// export ends with EXPORT_TOO_LARGE before it is downloaded, or as soon as
// streaming passes a limit.
export const MAX_EXPORT_PRODUCTS = 100_000;
export const MAX_EXPORT_BYTES = 1024 ** 3;
// A product or image line of this query is a few KiB at most.
export const MAX_EXPORT_LINE_BYTES = 64 * 1024;
// A segment holds at most 100 products and ends at the first product after
// 1 MiB of retained product and image lines, counted in UTF-8 bytes. A single
// product may retain at most 1 MiB, so a step holds at most 2 MiB of export
// lines whatever the catalog size. Variant lines are read for the first
// price only and never count towards a segment.
export const SEGMENT_BYTES = 1024 ** 2;
// Bump whenever segment boundaries or batch contents change: an import
// planned differently is never resumed under the same idempotency keys.
export const EXPORT_PLAN_VERSION = 1;
// Longest wait for the export's response or its next chunk. A step reads for
// at most its budget and two of these, however slowly the export arrives.
export const EXPORT_READ_TIMEOUT_MS = 20_000;

// Shopify must finish the export within a day of its submission, and the
// admitted import must finish within a day of that. The credential-bearing
// context outlives both windows, so an active import never loses it. It is
// released as soon as the import ends or is retired, and never renewed.
export const CATALOG_EXPORT_WINDOW_MS = 24 * 3600_000;
export const CATALOG_IMPORT_WINDOW_MS = 24 * 3600_000;
export const BACKFILL_CONTEXT_TTL_SECONDS =
  (CATALOG_EXPORT_WINDOW_MS + CATALOG_IMPORT_WINDOW_MS) / 1000 + 3600;

// Bulk queries take no variables. The validated publication GID is embedded so
// every product row carries explicit membership in Aura's own channel.
export function buildBulkProductsQuery(publicationId: string): string {
  if (!PUBLICATION_GID.test(publicationId))
    throw new Error("Invalid Shopify publication ID");
  return `
{
  products {
    edges {
      node {
        id
        title
        handle
        status
        totalInventory
        tracksInventory
        onlineStoreUrl
        publishedOnPublication(publicationId: "${publicationId}")
        images {
          edges {
            node {
              id
              url
            }
          }
        }
        variants(first: 1) {
          edges {
            node {
              id
              price
            }
          }
        }
      }
    }
  }
}
`;
}

const SHOP_METADATA_QUERY = `
query {
  shopLocales {
    locale
    primary
  }
  shop {
    currencyCode
  }
}
`;

// Grouped output lists each product's images and variants directly after it,
// so the export can be streamed product by product. Shopify does not
// guarantee that order without it.
const SUBMIT_BULK_OPERATION_MUTATION = `
mutation BulkOperationRunQuery($query: String!) {
  bulkOperationRunQuery(query: $query, groupObjects: true) {
    bulkOperation {
      id
      status
    }
    userErrors {
      field
      message
    }
  }
}
`;

const BULK_OPERATION_STATUS_QUERY = `
query BulkOperationStatus($id: ID!) {
  node(id: $id) {
    ... on BulkOperation {
      id
      status
      errorCode
      objectCount
      rootObjectCount
      fileSize
      url
    }
  }
}
`;

const SUPPORTED_CURRENCIES = new Set(Object.keys(CURRENCY_MINOR_UNITS));

const SHOPIFY_LOCALE_TO_LANGUAGE: Record<string, LanguageData> = {
  de: "de",
  en: "en",
  fr: "fr",
  es: "es",
  it: "it",
  zh: "zh",
  pt: "pt",
  pl: "pl",
  tr: "tr",
  nl: "nl",
  cs: "cs",
  ja: "ja",
  ru: "ru",
  ar: "ar",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BackfillContext {
  listingSourceId: string;
  accessToken: string;
  apiBaseUrl: string;
  primaryLocale?: string;
  currencyCode: CurrencyData;
  shopDomain: string;

  bulkOperationId: string;
  // The channel publication whose membership the snapshot reads.
  publicationId: string;
  createdAt: string;
}

export interface ShopMetadata {
  primaryLocale?: string;
  currencyCode?: string;
}

export interface ValidatedShopifyMetadata {
  primaryLocale?: string;
  currencyCode: CurrencyData;
}

interface GraphqlResponse {
  data?: Record<string, unknown>;
  errors?: unknown;
}

export type GraphqlRequestFn = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<GraphqlResponse>;

export interface BulkJsonlProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  totalInventory: number;
  tracksInventory: boolean;
  onlineStoreUrl: string | null;
  publishedOnPublication?: boolean | null;
}

export interface BulkOperationResult {
  url: string | null;
  rootObjectCount: number | null;
  // Bytes of the file at `url`, when Shopify reported them.
  fileSize: number | null;
}

export type BulkOperationState = "completed" | "failed" | "running";

export interface BackfillBatch {
  verb: "put" | "delete";
  index: number;
  items: UpsertProductListingData[] | WithdrawProductListingData[];
}

// One product of the export with the children the import reads.
export interface ExportProduct {
  product: BulkJsonlProduct;
  images: string[];
  // Price of the first variant.
  price: string | null;
}

// Consecutive products of the export. Both offsets are byte offsets of a
// product boundary, so a segment never splits a product from its children.
export interface ExportSegment {
  start: number;
  end: number;
  products: ExportProduct[];
}

// Deterministic for one immutable export, so a resumed import replays the
// same batches under the same idempotency keys.
export interface SegmentPlan {
  eligible: number;
  // Products with unknown membership or unmappable data; never submitted.
  rejected: string[];
  // Products whose channel membership could not be read.
  unknown: number;
  // At most one upsert and one withdrawal batch, sent in this order.
  batches: BackfillBatch[];
}

// Durable progress of one catalog import. It holds no credentials.
export interface CatalogImportJob {
  shop: string;
  // The import generation that owns this job, its context, status and alarm.
  generation: number;
  bulkOperationId: string;
  // EXPORT_PLAN_VERSION of the segments and batches this job sends.
  plan: number;
  // When the export was submitted (epoch milliseconds).
  queuedAt: number;
  // Shopify reported the export complete and the importer admitted it.
  admitted: boolean;
  admittedAt?: number;
  result?: BulkOperationResult;
  // Byte offset and index of the next segment of the export.
  offset: number;
  cursor: number;
  // Batches of that segment already sent.
  part: number;
  // Products of the segments counted so far.
  total: number;
  eligible: number;
  rejected: number;
  unknown: number;
  failed: number;
  withdrawn: number;
  attempts: number;
}

// The export is not well-formed, grouped JSONL. A retry reads the same file.
export class MalformedExportError extends Error {}

// The export exceeds the supported catalog size.
export class ExportCapacityError extends Error {}

// The shop's import generations, owned by its CatalogImporter. Each import
// begins a new generation, which retires the previous one; only the current
// generation can queue an export or record a status.
export interface CatalogImports {
  // Null when the connection no longer acts for the shop.
  begin(): Promise<number | null>;
  queue(generation: number, context: BackfillContext): Promise<boolean>;
  fail(generation: number, error: CatalogImportError): Promise<boolean>;
  status(): Promise<CatalogImportStatus | null>;
}

// The imports of a shop's CatalogImporter, begun by `begin`.
export function catalogImportsOf(
  importer: Omit<CatalogImports, "begin">,
  begin: CatalogImports["begin"],
): CatalogImports {
  return {
    begin,
    queue: (generation, context) => importer.queue(generation, context),
    fail: (generation, error) => importer.fail(generation, error),
    status: () => importer.status(),
  };
}

// Thrown once an import's generation was retired. No batch is sent for it.
export class SupersededImportError extends Error {
  constructor() {
    super("Catalog import generation was retired");
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function stringifyGraphqlError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

function collectGraphqlErrorMessages(errors: unknown): string[] {
  if (!errors) {
    return [];
  }

  if (Array.isArray(errors)) {
    return errors
      .flatMap((error) => collectGraphqlErrorMessages(error))
      .filter(Boolean);
  }

  if (typeof errors === "string") {
    return errors ? [errors] : [];
  }

  if (errors && typeof errors === "object") {
    const nestedErrors =
      (errors as { graphQLErrors?: unknown; errors?: unknown }).graphQLErrors ??
      (errors as { errors?: unknown }).errors;

    if (nestedErrors && nestedErrors !== errors) {
      const nestedMessages = collectGraphqlErrorMessages(nestedErrors);
      if (nestedMessages.length > 0) {
        return nestedMessages;
      }
    }
  }

  return [stringifyGraphqlError(errors)];
}

function formatGraphqlErrors(errors: unknown): string | null {
  const messages = collectGraphqlErrorMessages(errors);
  return messages.length > 0 ? messages.join(", ") : null;
}

export function extractShopifyNumericId(gid: string): string {
  const parts = gid.split("/");
  return parts[parts.length - 1];
}

export function mapShopifyAvailability(
  tracksInventory: boolean,
  totalInventory: number,
): ListingAvailabilityData | null {
  if (!tracksInventory) return null;
  return totalInventory > 0 ? "IN_STOCK" : "OUT_OF_STOCK";
}

export function mapShopifyLocaleToLanguage(
  shopifyLocale?: string | null,
): LanguageData | undefined {
  if (!shopifyLocale) {
    return undefined;
  }

  const base = shopifyLocale.split("-")[0].toLowerCase();
  return SHOPIFY_LOCALE_TO_LANGUAGE[base];
}

export function resolveLanguage(shopifyLocale?: string): LanguageData {
  return mapShopifyLocaleToLanguage(shopifyLocale) ?? "en";
}

export function mapShopifyCurrencyCode(
  currencyCode?: string | null,
): CurrencyData | undefined {
  const normalizedCurrencyCode = currencyCode as CurrencyData | undefined;

  if (
    !normalizedCurrencyCode ||
    !SUPPORTED_CURRENCIES.has(normalizedCurrencyCode)
  ) {
    return undefined;
  }

  return normalizedCurrencyCode;
}

export function requireSupportedShopifyCurrency(
  currencyCode?: string | null,
): CurrencyData {
  const currency = mapShopifyCurrencyCode(currencyCode);
  if (!currency) {
    throw new Error(
      `Unsupported or missing Shopify currency: ${currencyCode ?? "missing"}`,
    );
  }
  return currency;
}

export function normalizeShopifyDomain(
  shopDomain?: string | null,
): string | undefined {
  const normalizedShopDomain = shopDomain?.trim().toLowerCase();

  if (!normalizedShopDomain) {
    return undefined;
  }

  return normalizedShopDomain;
}

export function buildShopifyIngestionConfiguration(
  metadata: ShopMetadata,
  shopDomain: string,
): PutShopifyListingSourceIngestionConfigurationData {
  const domain = normalizeShopifyDomain(shopDomain);
  if (!domain || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error("Invalid Shopify domain for ingestion configuration");
  }
  return {
    domain,
    currency: requireSupportedShopifyCurrency(metadata.currencyCode),
    ...(mapShopifyLocaleToLanguage(metadata.primaryLocale) && {
      language: mapShopifyLocaleToLanguage(metadata.primaryLocale),
    }),
  };
}

// ---------------------------------------------------------------------------
// Product transformation
// ---------------------------------------------------------------------------

// Shopify returns decimal price strings. Convert via integer arithmetic, never float rounding.
function toMinorUnits(price: string, exponent: number): number | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(price);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > exponent && /[1-9]/.test(fraction.slice(exponent)))
    return null;
  const amount =
    BigInt(match[1]) * 10n ** BigInt(exponent) +
    BigInt((fraction.slice(0, exponent) || "").padEnd(exponent, "0") || "0");
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : null;
}

export function transformProduct(
  product: BulkJsonlProduct,
  images: string[],
  variantPrice: string | null,
  locale: string | undefined,
  currencyCode: string,
  shopDomain: string,
): UpsertProductListingData {
  const currency = mapShopifyCurrencyCode(currencyCode);
  const amount =
    currency && variantPrice !== null
      ? toMinorUnits(variantPrice, CURRENCY_MINOR_UNITS[currency])
      : null;
  const handle = product.handle?.trim();
  const url =
    product.onlineStoreUrl ??
    (handle
      ? `https://${normalizeShopifyDomain(shopDomain)}/products/${encodeURIComponent(handle)}`
      : null);
  if (!url)
    throw new Error(`Missing storefront URL for Shopify product ${product.id}`);

  return {
    sourceListingId: extractShopifyNumericId(product.id),
    title: { text: product.title, language: resolveLanguage(locale) },
    price:
      currency && amount !== null
        ? { type: "MONETARY", currency, amount }
        : null,
    availability: mapShopifyAvailability(
      product.tracksInventory,
      product.totalInventory,
    ),
    url,
    images,
  };
}

export function transformWithdrawal(
  product: BulkJsonlProduct,
): WithdrawProductListingData {
  return { sourceListingId: extractShopifyNumericId(product.id) };
}

type ShopifyBackfillAction = "upsert" | "withdraw" | "ignore" | "unknown";

export function classifyShopifyBackfillAction(
  product: BulkJsonlProduct,
): ShopifyBackfillAction {
  switch (product.status) {
    case "ACTIVE":
      // Only explicit membership in Aura's own publication admits a listing.
      // A missing or malformed read is unknown, never eligible or ineligible.
      if (product.publishedOnPublication === true) return "upsert";
      if (product.publishedOnPublication === false) return "withdraw";
      return "unknown";
    case "DRAFT":
    case "ARCHIVED":
      return "withdraw";
    default:
      return "ignore";
  }
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

export interface ExportLine {
  text: string;
  // Byte offsets of the line in the export, the end after its newline.
  start: number;
  end: number;
}

function concatBytes(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

// Splits the export into lines by byte. Offsets stay exact for multibyte
// text, and a line or character split across chunks is joined before it is
// decoded. Only the current line is buffered.
export class ExportLines {
  private chunk: Uint8Array = new Uint8Array(0);
  private index = 0;
  private partial: Uint8Array[] = [];
  private partialBytes = 0;
  private ended = false;
  private received: number;
  private skip: number;
  private readonly size: number | null;
  private readonly limit: number;
  private readonly deadline: number;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null,
    // Byte offset of the first line.
    public position: number,
    {
      // Leading bytes to drop when the server ignored the requested range.
      skip = 0,
      // The export's size. A download that ends elsewhere was cut off, and
      // one of unknown size is never verified complete.
      size = null,
      limit = MAX_EXPORT_BYTES,
      // When reading must have finished (epoch milliseconds).
      deadline = Number.POSITIVE_INFINITY,
    }: {
      skip?: number;
      size?: number | null;
      limit?: number;
      deadline?: number;
    } = {},
  ) {
    this.received = position;
    this.skip = skip;
    this.size = size;
    this.limit = limit;
    this.deadline = deadline;
  }

  // The whole export of a known size was read.
  get verified() {
    return this.ended && this.size !== null;
  }

  // The next line, or null at the end of the export.
  async next(): Promise<ExportLine | null> {
    for (;;) {
      if (this.index < this.chunk.length) {
        const newline = this.chunk.indexOf(0x0a, this.index);
        const stop = newline === -1 ? this.chunk.length : newline;
        const piece = this.chunk.subarray(this.index, stop);
        this.index = newline === -1 ? stop : stop + 1;
        if (this.partialBytes + piece.length > MAX_EXPORT_LINE_BYTES)
          throw new ExportCapacityError(
            `Shopify catalog export line at byte ${this.position} exceeds ${MAX_EXPORT_LINE_BYTES} bytes`,
          );
        this.partial.push(piece);
        this.partialBytes += piece.length;
        if (newline !== -1) return this.take(1);
      } else if (this.ended) {
        // The last line may have no newline.
        return this.partialBytes > 0 ? this.take(0) : null;
      } else {
        await this.fill();
      }
    }
  }

  async close() {
    await this.reader?.cancel().catch(() => undefined);
  }

  private take(newline: number): ExportLine {
    const bytes = concatBytes(this.partial, this.partialBytes);
    const start = this.position;
    this.position += this.partialBytes + newline;
    this.partial = [];
    this.partialBytes = 0;
    try {
      return { text: this.decoder.decode(bytes), start, end: this.position };
    } catch {
      throw new MalformedExportError(
        `Shopify catalog export has invalid UTF-8 at byte ${start}`,
      );
    }
  }

  private async fill() {
    const { done, value } = this.reader
      ? await this.read(this.reader)
      : ({ done: true, value: undefined } as const);
    if (done) {
      // A connection that closed early is transient, never a short export.
      if (this.size !== null && this.received !== this.size)
        throw new Error("Shopify catalog export download was cut off");
      this.ended = true;
      return;
    }
    const dropped = Math.min(this.skip, value.length);
    this.skip -= dropped;
    this.chunk = value.subarray(dropped);
    this.index = 0;
    this.received += this.chunk.length;
    if (this.received > this.limit)
      throw new ExportCapacityError(
        `Shopify catalog export exceeds ${this.limit} bytes`,
      );
  }

  private async read(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const wait = Math.min(EXPORT_READ_TIMEOUT_MS, this.deadline - Date.now());
    if (wait <= 0)
      throw new Error("Shopify catalog export download is too slow");
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Shopify catalog export download stalled")),
          wait,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }
}

function parseExportRecord(line: ExportLine): Record<string, unknown> {
  let record: unknown = null;
  try {
    record = JSON.parse(line.text);
  } catch {}
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new MalformedExportError(
      `Shopify catalog export has an invalid line at byte ${line.start}`,
    );
  return record as Record<string, unknown>;
}

// Reads the export segment by segment. Shopify's grouped output lists each
// product's images and variants directly after it, so a segment ends right
// before a product line. A child of any other product is malformed.
export class ExportSegments {
  private lookahead: ExportLine | null = null;

  constructor(private readonly lines: ExportLines) {}

  // The next segment, or null at the end of the export.
  async next(): Promise<ExportSegment | null> {
    const start = this.lookahead?.start ?? this.lines.position;
    const products: ExportProduct[] = [];
    let current: ExportProduct | undefined;
    let priced = false;
    let productBytes = 0;
    let retained = 0;
    for (;;) {
      const line = this.lookahead ?? (await this.lines.next());
      this.lookahead = null;
      if (!line) break;
      if (!line.text.trim()) continue;
      const record = parseExportRecord(line);
      const bytes = line.end - line.start;
      if (record.__parentId === undefined) {
        if (products.length === BATCH_SIZE || retained >= SEGMENT_BYTES) {
          this.lookahead = line;
          return { start, end: line.start, products };
        }
        if (typeof record.id !== "string")
          throw new MalformedExportError(
            `Shopify catalog export has a product without an ID at byte ${line.start}`,
          );
        current = {
          product: record as unknown as BulkJsonlProduct,
          images: [],
          price: null,
        };
        products.push(current);
        priced = false;
        productBytes = bytes;
      } else if (record.__parentId !== current?.product.id) {
        throw new MalformedExportError(
          `Shopify catalog export lists a child outside its product at byte ${line.start}`,
        );
      } else if (record.url && record.price === undefined) {
        current.images.push(record.url as string);
        productBytes += bytes;
      } else {
        // Only the first variant's price is read.
        if (record.price !== undefined && !priced) {
          current.price = record.price as string | null;
          priced = true;
        }
        continue;
      }
      retained += bytes;
      if (productBytes > SEGMENT_BYTES)
        throw new ExportCapacityError(
          `Shopify product ${current.product.id} exceeds ${SEGMENT_BYTES} bytes of export data`,
        );
    }
    return products.length > 0
      ? { start, end: this.lines.position, products }
      : null;
  }

  // The whole export of a known size was read.
  get verified() {
    return this.lines.verified;
  }

  close() {
    return this.lines.close();
  }
}

// Plans the batches of one segment. Batch indexes are segment indexes, so
// keys stay deterministic: an index may have an upsert batch, a withdrawal
// batch, both or neither.
export function planSegment(
  segment: ExportSegment,
  index: number,
  context: BackfillContext,
): SegmentPlan {
  let eligible = 0;
  let unknown = 0;
  const upserts: UpsertProductListingData[] = [];
  const withdrawals: WithdrawProductListingData[] = [];
  const rejected: string[] = [];
  for (const { product, images, price } of segment.products) {
    const action = classifyShopifyBackfillAction(product);
    if (action === "withdraw") {
      // Drafts, archived and unpublished products in the export are withdrawn
      // by their own ID. Nothing is withdrawn for being absent from it.
      withdrawals.push(transformWithdrawal(product));
    } else if (action === "unknown") {
      unknown++;
      rejected.push(extractShopifyNumericId(product.id));
    } else if (action === "upsert") {
      eligible++;
      try {
        upserts.push(
          transformProduct(
            product,
            images,
            price,
            context.primaryLocale,
            context.currencyCode,
            context.shopDomain,
          ),
        );
      } catch {
        rejected.push(extractShopifyNumericId(product.id));
      }
    }
  }
  const batches: BackfillBatch[] = [];
  if (upserts.length > 0) batches.push({ verb: "put", index, items: upserts });
  if (withdrawals.length > 0)
    batches.push({ verb: "delete", index, items: withdrawals });
  return { eligible, rejected, unknown, batches };
}

// ---------------------------------------------------------------------------
// Backfill context KV helpers
// ---------------------------------------------------------------------------

// Every import generation keeps its own credential-bearing context. Cleanup of
// an older import therefore never deletes or replaces a newer one's.
function backfillContextKey(shop: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation <= 0)
    throw new Error("Invalid catalog import generation");
  return `${BACKFILL_CONTEXT_PREFIX}${shop.toLowerCase()}:${generation}`;
}

export async function storeBackfillContext(
  kv: {
    put: (
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) => Promise<void>;
  },
  shop: string,
  generation: number,
  context: BackfillContext,
): Promise<void> {
  await kv.put(backfillContextKey(shop, generation), JSON.stringify(context), {
    expirationTtl: BACKFILL_CONTEXT_TTL_SECONDS,
  });
}

export async function loadBackfillContext(
  kv: { get: (key: string) => Promise<string | null> },
  shop: string,
  generation: number,
): Promise<BackfillContext | null> {
  const raw = await kv.get(backfillContextKey(shop, generation));
  if (!raw) return null;
  try {
    const context: unknown = JSON.parse(raw);
    if (!context || typeof context !== "object") return null;
    const value = context as Partial<BackfillContext>;
    return typeof value.listingSourceId === "string" &&
      isValidListingSourceId(value.listingSourceId) &&
      typeof value.accessToken === "string" &&
      typeof value.apiBaseUrl === "string" &&
      typeof value.shopDomain === "string" &&
      typeof value.bulkOperationId === "string" &&
      typeof value.publicationId === "string" &&
      PUBLICATION_GID.test(value.publicationId) &&
      (value.primaryLocale === undefined ||
        typeof value.primaryLocale === "string") &&
      mapShopifyCurrencyCode(value.currencyCode) &&
      typeof value.createdAt === "string"
      ? (value as BackfillContext)
      : null;
  } catch {
    return null;
  }
}

export async function clearBackfillContext(
  kv: { delete: (key: string) => Promise<void> },
  shop: string,
  generation: number,
): Promise<void> {
  await kv.delete(backfillContextKey(shop, generation));
}

// ---------------------------------------------------------------------------
// Shop metadata (locale + currency)
// ---------------------------------------------------------------------------

interface ShopLocale {
  locale: string;
  primary: boolean;
}

interface ShopMetadataResponse {
  data?: {
    shopLocales?: ShopLocale[];
    shop?: { currencyCode: string };
  };
  errors?: unknown;
}

export async function fetchShopMetadata(
  graphqlRequest: GraphqlRequestFn,
): Promise<ShopMetadata> {
  const response = (await graphqlRequest(
    SHOP_METADATA_QUERY,
    {},
  )) as ShopMetadataResponse;

  const errorMessage = formatGraphqlErrors(response.errors);
  if (errorMessage) {
    throw new Error(`Failed to fetch shop metadata: ${errorMessage}`);
  }

  const locales = response.data?.shopLocales ?? [];
  const primary = locales.find((l) => l.primary);
  const primaryLocale = primary?.locale;
  const currencyCode = response.data?.shop?.currencyCode;

  return { primaryLocale, currencyCode };
}

// ---------------------------------------------------------------------------
// Bulk operation submission
// ---------------------------------------------------------------------------

interface BulkOperationSubmitResponse {
  data?: {
    bulkOperationRunQuery?: {
      bulkOperation?: { id: string; status: string } | null;
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  };
  errors?: unknown;
}

export async function submitBulkOperation(
  graphqlRequest: GraphqlRequestFn,
  publicationId: string,
): Promise<string> {
  const query = buildBulkProductsQuery(publicationId);
  const response = (await graphqlRequest(SUBMIT_BULK_OPERATION_MUTATION, {
    query,
  })) as BulkOperationSubmitResponse;

  const errorMessage = formatGraphqlErrors(response.errors);
  if (errorMessage) {
    throw new Error(`Bulk operation submission failed: ${errorMessage}`);
  }

  const result = response.data?.bulkOperationRunQuery;
  const userErrors = result?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(
      `Bulk operation user errors: ${userErrors.map((e) => e.message).join(", ")}`,
    );
  }

  const opId = result?.bulkOperation?.id;
  if (!opId) {
    throw new Error("Bulk operation submission returned no operation ID");
  }

  return opId;
}

// ---------------------------------------------------------------------------
// Bulk operation result fetching (used in webhook handler)
// ---------------------------------------------------------------------------

interface BulkOperationNodeResponse {
  data?: {
    node?: {
      id: string;
      status: string;
      errorCode: string | null;
      objectCount?: string;
      rootObjectCount?: string;
      fileSize?: string | null;
      url: string | null;
    } | null;
  };
  errors?: unknown;
}

function parseCount(value: unknown): number | null {
  const count =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(count) ? count : null;
}

async function readBulkOperation(
  graphqlRequest: GraphqlRequestFn,
  bulkOperationId: string,
) {
  const json = (await graphqlRequest(BULK_OPERATION_STATUS_QUERY, {
    id: bulkOperationId,
  })) as BulkOperationNodeResponse;

  const errorMessage = formatGraphqlErrors(json.errors);
  if (errorMessage) {
    throw new Error(`Failed to query bulk operation: ${errorMessage}`);
  }
  return json.data?.node;
}

export async function fetchBulkOperationResult(
  graphqlRequest: GraphqlRequestFn,
  bulkOperationId: string,
): Promise<BulkOperationResult> {
  const node = await readBulkOperation(graphqlRequest, bulkOperationId);
  if (node?.status !== "COMPLETED" || node.errorCode)
    throw new Error("Shopify catalog export did not complete");
  if (!node.url && node.objectCount !== "0")
    throw new Error("Shopify catalog export has no download URL");

  return {
    url: node.url ?? null,
    rootObjectCount: parseCount(node.rootObjectCount),
    fileSize: parseCount(node.fileSize),
  };
}

// Where Shopify's export stands while the import waits for it. A missing
// operation can never complete.
export async function readBulkOperationState(
  graphqlRequest: GraphqlRequestFn,
  bulkOperationId: string,
): Promise<BulkOperationState> {
  const node = await readBulkOperation(graphqlRequest, bulkOperationId);
  if (node?.status === "COMPLETED") return "completed";
  if (
    !node ||
    node.status === "FAILED" ||
    node.status === "CANCELED" ||
    node.status === "EXPIRED"
  )
    return "failed";
  return "running";
}

const CANCEL_BULK_OPERATION_MUTATION = `
mutation BulkOperationCancel($id: ID!) {
  bulkOperationCancel(id: $id) {
    userErrors {
      field
      message
    }
  }
}
`;

// Stops an export the import gave up on, so it does not hold Shopify's bulk
// query capacity for up to its ten days.
export async function cancelBulkOperation(
  graphqlRequest: GraphqlRequestFn,
  bulkOperationId: string,
): Promise<void> {
  const response = await graphqlRequest(CANCEL_BULK_OPERATION_MUTATION, {
    id: bulkOperationId,
  });
  const errors =
    formatGraphqlErrors(response.errors) ??
    formatGraphqlErrors(
      (
        response.data?.bulkOperationCancel as
          | { userErrors?: Array<{ message: string }> }
          | undefined
      )?.userErrors?.map(({ message }) => message),
    );
  if (errors) throw new Error(`Bulk operation cancellation failed: ${errors}`);
}

// ---------------------------------------------------------------------------
// Sending products to external API
// ---------------------------------------------------------------------------

export function createBackfillIdempotencyKey(
  bulkOperationId: string,
  verb: "put" | "delete",
  batchIndex: number,
): string {
  const operationId = /^gid:\/\/shopify\/BulkOperation\/(\d+)$/.exec(
    bulkOperationId,
  )?.[1];
  if (!operationId || !Number.isSafeInteger(batchIndex) || batchIndex < 0) {
    throw new Error("Invalid bulk operation ID or batch index");
  }
  const key = `shopify-backfill-${operationId}-${verb}-${batchIndex}`;
  if (key.length > 128)
    throw new Error("Bulk operation ID exceeds idempotency key limit");
  return key;
}

function isBatchReport(
  value: unknown,
): value is AsyncProductListingBatchReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<AsyncProductListingBatchReport>;
  return (
    typeof report.submissionId === "string" &&
    Number.isSafeInteger(report.acceptedCount) &&
    (report.acceptedCount as number) >= 0 &&
    Array.isArray(report.failures) &&
    report.failures.every(
      (failure) =>
        failure !== null &&
        typeof failure === "object" &&
        Number.isSafeInteger(failure.index) &&
        typeof failure.retryable === "boolean",
    )
  );
}

function reportFailures(
  report: AsyncProductListingBatchReport,
  items: Array<UpsertProductListingData | WithdrawProductListingData>,
): string[] {
  if (
    report.acceptedCount + report.failures.length !== items.length ||
    new Set(report.failures.map(({ index }) => index)).size !==
      report.failures.length ||
    report.failures.some(({ index }) => index < 0 || index >= items.length)
  ) {
    throw new Error("Invalid async ProductListing admission report");
  }
  return report.failures.map(({ index }) => items[index].sourceListingId);
}

export async function sendProductBatch(
  items: UpsertProductListingData[] | WithdrawProductListingData[],
  apiBaseUrl: string,
  listingSourceId: string,
  accessToken: string,
  verb: "put" | "delete",
  idempotencyKey: string,
  // Runs before a resend and throws once the import was retired.
  beforeRetry: () => Promise<void> = async () => {},
): Promise<string[]> {
  if (items.length > BATCH_SIZE)
    throw new Error("Async batch exceeds 100 items");
  const client = createClient({ baseUrl: apiBaseUrl });
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Idempotency-Key": idempotencyKey,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await beforeRetry();
    const result =
      verb === "put"
        ? await putAsyncPartnerProductListings({
            client,
            body: items as UpsertProductListingData[],
            path: { listingSourceId },
            headers,
            signal: AbortSignal.timeout(20_000),
          })
        : await deleteAsyncPartnerProductListings({
            client,
            body: items as WithdrawProductListingData[],
            path: { listingSourceId },
            headers,
            signal: AbortSignal.timeout(20_000),
          });
    const report: unknown = result.error ?? result.data;
    if (isBatchReport(report)) {
      if (report.failures.some((failure) => failure.retryable) && attempt < 2)
        continue;
      return reportFailures(report, items);
    }
    // A response-less error may be a timeout after queue admission. Retry only
    // the identical ordered body with the same key; never compact failed entries.
    if ((!result.response || result.response.status === 503) && attempt < 2)
      continue;
    const status = result.response?.status ?? "transport";
    throw new Error(`ProductListing admission failed (${status})`);
  }
  throw new Error("ProductListing admission retry limit reached");
}

export async function configureShopifyListingSource(
  graphqlRequest: GraphqlRequestFn,
  apiBaseUrl: string,
  listingSourceId: string,
  accessToken: string,
  shopDomain: string,
): Promise<ValidatedShopifyMetadata> {
  const metadata = await fetchShopMetadata(graphqlRequest);
  const validatedMetadata: ValidatedShopifyMetadata = {
    primaryLocale: metadata.primaryLocale,
    currencyCode: requireSupportedShopifyCurrency(metadata.currencyCode),
  };
  await putShopifyIngestionConfiguration(
    apiBaseUrl,
    listingSourceId,
    accessToken,
    validatedMetadata,
    shopDomain,
  );
  return validatedMetadata;
}

export async function putShopifyIngestionConfiguration(
  apiBaseUrl: string,
  listingSourceId: string,
  accessToken: string,
  metadata: ShopMetadata,
  shopDomain: string,
): Promise<boolean> {
  const result = await putShopifyListingSourceIngestionConfiguration({
    client: createClient({ baseUrl: apiBaseUrl }),
    body: buildShopifyIngestionConfiguration(metadata, shopDomain),
    path: { listingSourceId },
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (result.response?.status !== 201 && result.response?.status !== 204) {
    throw new Error(
      `Shopify ingestion configuration failed (${result.response?.status ?? "transport"})`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Process bulk operation results (resumable catalog import steps)
// ---------------------------------------------------------------------------

// Opens the export at a segment boundary. Shopify's signed result URL serves
// byte ranges, so a resumed step downloads only what it has not consumed. A
// server that ignores the range is skipped forward instead. The export's
// size is Shopify's `fileSize`, or else what the response reports for an
// unencoded body.
export async function openBackfillExport(
  result: BulkOperationResult,
  offset: number,
  deadline = Number.POSITIVE_INFINITY,
): Promise<ExportSegments> {
  const segments = (
    reader: ReadableStreamDefaultReader<Uint8Array> | null,
    size: number | null,
    skip = 0,
  ) =>
    new ExportSegments(
      new ExportLines(reader, offset, { size, skip, deadline }),
    );
  // An export without a URL has no objects.
  if (!result.url) return segments(null, 0);
  if (result.fileSize !== null && offset >= result.fileSize)
    return segments(null, result.fileSize);
  // The timeout covers the response only; each chunk has its own, so a step
  // can stream for longer than one timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_READ_TIMEOUT_MS);
  const response = await fetch(result.url, {
    headers: { Range: `bytes=${offset}-` },
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  const range = /^bytes (\d+-\d+|\*)\/(\d+)$/.exec(
    response.headers.get("Content-Range") ?? "",
  );
  const size =
    result.fileSize ??
    (response.status === 200
      ? response.headers.has("Content-Encoding")
        ? null
        : parseCount(response.headers.get("Content-Length"))
      : parseCount(range?.[2]));
  if (response.status === 416) {
    await response.body?.cancel();
    return segments(null, size);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Failed to download JSONL: ${response.status}`);
  }
  if (response.status === 206 && !range?.[1].startsWith(`${offset}-`)) {
    await response.body?.cancel();
    throw new Error("Shopify catalog export returned another byte range");
  }
  return segments(
    response.body?.getReader() ?? null,
    size,
    response.status === 206 ? 0 : offset,
  );
}

// Progress of the counted segments, reported in every status.
export function catalogProgress(job: CatalogImportJob) {
  return {
    total: job.total,
    eligible: job.eligible,
    withdrawn: job.withdrawn,
    failed: job.failed + job.rejected,
  };
}

function exceedsCapacity(result: BulkOperationResult) {
  return (
    (result.rootObjectCount ?? 0) > MAX_EXPORT_PRODUCTS ||
    (result.fileSize ?? 0) > MAX_EXPORT_BYTES
  );
}

async function submitBackfillBatch(
  batch: BackfillBatch,
  context: BackfillContext,
  beforeRetry: () => Promise<void>,
): Promise<string[]> {
  try {
    return await sendProductBatch(
      batch.items,
      context.apiBaseUrl,
      context.listingSourceId,
      context.accessToken,
      batch.verb,
      createBackfillIdempotencyKey(
        context.bulkOperationId,
        batch.verb,
        batch.index,
      ),
      beforeRetry,
    );
  } catch (error) {
    if (error instanceof SupersededImportError) throw error;
    console.error(
      `Backfill ${batch.verb} batch ${batch.index} failed:`,
      (error instanceof Error ? error.message : "unknown error")
        .replaceAll(context.accessToken, "[redacted]")
        .slice(0, 180),
    );
    return batch.items.map((item) => item.sourceListingId);
  }
}

// Sends one segment's batches in order. The segment's counts are recorded
// with its first checkpoint and the job moves on to the next segment with its
// last one, so every checkpoint holds consistent counts.
async function importSegment(
  job: CatalogImportJob,
  segment: ExportSegment,
  context: BackfillContext,
  checkpoint: (job: CatalogImportJob) => Promise<void>,
) {
  if (segment.start !== job.offset)
    throw new Error("Catalog import segment does not start at its checkpoint");
  const plan = planSegment(segment, job.cursor, context);
  let counted = job.part > 0;
  const count = () => {
    if (counted) return;
    counted = true;
    if (plan.rejected.length > 0 && job.rejected < 50)
      console.error(
        `Backfill cannot classify or map ${plan.rejected.length} Shopify products: ${plan.rejected.slice(0, 50 - job.rejected).join(", ")}`,
      );
    job.total += segment.products.length;
    job.eligible += plan.eligible;
    job.rejected += plan.rejected.length;
    job.unknown += plan.unknown;
  };
  const advance = () => {
    count();
    job.offset = segment.end;
    job.cursor++;
    job.part = 0;
  };
  if (plan.batches.length === 0) {
    advance();
    await checkpoint(job);
    return;
  }
  for (let part = job.part; part < plan.batches.length; part++) {
    const batch = plan.batches[part];
    const failures = await submitBackfillBatch(batch, context, () =>
      checkpoint(job),
    );
    count();
    job.failed += failures.length;
    if (batch.verb === "delete")
      job.withdrawn += batch.items.length - failures.length;
    job.part = part + 1;
    if (job.part === plan.batches.length) advance();
    await checkpoint(job);
  }
}

// Runs one bounded step of an import. It streams the export from the job's
// checkpoint, one segment at a time, and never holds more than one segment.
// `checkpoint` persists the job after every admitted batch, so an
// interrupted step resumes at the next batch and a replayed batch reuses its
// idempotency key. It throws SupersededImportError once the job's generation
// was retired; every batch and resend is preceded by a successful checkpoint.
// Throws on Shopify read and download errors so the caller can retry the
// step.
export async function runCatalogImportStep(
  job: CatalogImportJob,
  context: BackfillContext,
  graphqlRequest: GraphqlRequestFn,
  budgetMs: number,
  checkpoint: (job: CatalogImportJob) => Promise<void>,
): Promise<{ done: boolean; status: Omit<CatalogImportStatus, "updatedAt"> }> {
  const result =
    job.result ??
    (await fetchBulkOperationResult(graphqlRequest, job.bulkOperationId));
  const failed = (error: CatalogImportError) => ({
    done: true,
    status: { phase: "failed" as const, ...catalogProgress(job), error },
  });
  // Every step writes with the current installation's access and publication.
  // A revoked scope, a channel rebound to another source or a replaced
  // publication invalidates the whole snapshot; an unreadable publication is a
  // transient read failure.
  const publication = await resolveChannelPublication(
    graphqlRequest,
    context.listingSourceId,
  );
  if (publication.state === "unavailable")
    throw new Error("Shopify channel publication could not be read");
  if (publication.state !== "ready")
    return failed(CHANNEL_PUBLICATION_ERRORS[publication.state]);
  if (publication.publicationId !== context.publicationId)
    return failed("PUBLICATION_CHANGED");
  // Shopify's own counts reject an oversized export before any download.
  if (exceedsCapacity(result)) {
    console.error(
      `Backfill export ${job.bulkOperationId} exceeds the supported size: ${result.rootObjectCount} products, ${result.fileSize} bytes`,
    );
    return failed("EXPORT_TOO_LARGE");
  }
  if (!job.result) {
    job.result = result;
    await checkpoint(job);
  }

  const segments = await openBackfillExport(
    result,
    job.offset,
    Date.now() + budgetMs + 2 * EXPORT_READ_TIMEOUT_MS,
  );
  // The budget starts once the export responds, and every step imports at
  // least one segment, so a slow download can never starve submission.
  const deadline = Date.now() + budgetMs;
  try {
    for (let first = true; first || Date.now() < deadline; first = false) {
      const segment = await segments.next();
      if (!segment) {
        // Only an export read to its known size, whose product rows match
        // Shopify's root count and whose memberships were all explicit is
        // complete. Unknown membership or a short export never is.
        const complete =
          segments.verified &&
          result.rootObjectCount === job.total &&
          job.unknown === 0;
        const progress = catalogProgress(job);
        return complete
          ? {
              done: true,
              status: {
                phase: progress.failed ? "failed" : "submitted",
                ...progress,
              },
            }
          : failed("INCOMPLETE_EXPORT");
      }
      // A resumed segment was counted with its first batch.
      if (
        job.part === 0 &&
        job.total + segment.products.length > MAX_EXPORT_PRODUCTS
      )
        throw new ExportCapacityError(
          `Shopify catalog export exceeds ${MAX_EXPORT_PRODUCTS} products`,
        );
      // Fence before sending: the import may have been retired meanwhile.
      await checkpoint(job);
      await importSegment(job, segment, context, checkpoint);
    }
  } catch (error) {
    // The same file is read on every retry: what was submitted stays
    // admitted, and the import ends as failed without further batches.
    if (
      error instanceof MalformedExportError ||
      error instanceof ExportCapacityError
    ) {
      console.error(
        `Backfill export ${job.bulkOperationId} cannot be imported: ${error.message}`,
      );
      return failed(
        error instanceof ExportCapacityError
          ? "EXPORT_TOO_LARGE"
          : "INCOMPLETE_EXPORT",
      );
    }
    throw error;
  } finally {
    await segments.close();
  }
  return {
    done: false,
    status: { phase: "processing", ...catalogProgress(job) },
  };
}

// ---------------------------------------------------------------------------
// Trigger backfill (called after OAuth configuration)
// ---------------------------------------------------------------------------

export async function triggerBackfill(
  graphqlRequest: GraphqlRequestFn,
  imports: CatalogImports,
  shopDomain: string,
  listingSourceId: string,
  accessToken: string,
  apiBaseUrl: string,
  validatedMetadata: ValidatedShopifyMetadata,
): Promise<boolean> {
  let generation: number | null = null;
  try {
    // Starting an import retires the shop's current one before anything is
    // read or exported, so the older import submits no further batch. A
    // connection that was disconnected or replaced cannot start one.
    generation = await imports.begin();
    if (generation === null) {
      console.warn(
        `Backfill not submitted for ${shopDomain}: connection retired`,
      );
      return false;
    }
    // Every import first (re)binds the installation's channel connection to
    // the authorized source, so a failed or missing setup is repaired by
    // importing again. A refusal is reported, never treated as connected.
    const channel = await ensureAuraChannel(graphqlRequest, listingSourceId);
    if (channel.state !== "ready") {
      await imports.fail(
        generation,
        CHANNEL_PROVISIONING_ERRORS[channel.state],
      );
      console.warn(
        `Backfill not submitted for ${shopDomain}: channel ${channel.state}`,
      );
      return false;
    }
    // Missing access, a missing publication or a failed read is a recoverable
    // sync state. It never falls back to importing every active product.
    const publication = await resolveChannelPublication(
      graphqlRequest,
      listingSourceId,
    );
    if (publication.state !== "ready") {
      await imports.fail(
        generation,
        CHANNEL_PUBLICATION_ERRORS[publication.state],
      );
      console.warn(
        `Backfill not submitted for ${shopDomain}: publication ${publication.state}`,
      );
      return false;
    }
    const bulkOperationId = await submitBulkOperation(
      graphqlRequest,
      publication.publicationId,
    );

    // A newer import, disconnect or replacement since begin() discards the
    // export; its completion webhook then admits nothing.
    if (
      !(await imports.queue(generation, {
        listingSourceId,
        accessToken,
        apiBaseUrl,
        primaryLocale: validatedMetadata.primaryLocale,
        currencyCode: validatedMetadata.currencyCode,
        shopDomain,
        bulkOperationId,
        publicationId: publication.publicationId,
        createdAt: new Date().toISOString(),
      }))
    ) {
      console.warn(`Backfill for ${shopDomain} was retired before queueing`);
      return false;
    }

    console.log(
      `Backfill bulk operation submitted for ${shopDomain}: ${bulkOperationId}`,
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Failed to submit backfill for ${shopDomain}:`,
      message
        .replaceAll(accessToken, "[redacted]")
        .replace(/\s+/g, " ")
        .slice(0, 180),
    );
    // The begun generation reports the failure instead of staying queued.
    if (generation !== null)
      await imports
        .fail(generation, "SHOPIFY_READ_FAILED")
        .catch(() => undefined);
    return false;
  }
}

// An import that stopped for missing Shopify access resumes once the merchant
// approved the updated scopes, exactly as "Import catalog again" would. Any
// other import state is the merchant's to retry.
export async function resumeCatalogImport(
  graphqlRequest: GraphqlRequestFn,
  imports: CatalogImports,
  shopDomain: string,
  listingSourceId: string,
  accessToken: string,
  apiBaseUrl: string,
): Promise<boolean> {
  try {
    const status = await imports.status();
    if (status?.phase !== "failed" || status.error !== "MISSING_SCOPE")
      return false;
    if ((await readCatalogAccess(graphqlRequest)) !== "granted") return false;
    const metadata = await configureShopifyListingSource(
      graphqlRequest,
      apiBaseUrl,
      listingSourceId,
      accessToken,
      shopDomain,
    );
    return await triggerBackfill(
      graphqlRequest,
      imports,
      shopDomain,
      listingSourceId,
      accessToken,
      apiBaseUrl,
      metadata,
    );
  } catch (error) {
    console.error(
      `Catalog import did not resume for ${shopDomain}:`,
      (error instanceof Error ? error.message : String(error))
        .replaceAll(accessToken, "[redacted]")
        .replace(/\s+/g, " ")
        .slice(0, 180),
    );
    return false;
  }
}
