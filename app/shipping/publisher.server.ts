import { createClient } from "../generated/api/client";
import {
  assignShippingDefault,
  changeProductListingDelivery,
  clearShippingDefault,
  createShippingProfile,
  getProductListingDelivery,
  getShippingDefault,
  getShippingProfile,
  listShippingProfiles,
  replaceShippingProfile,
  restoreShippingProfile,
  retireShippingProfile,
} from "../generated/api/sdk.gen";
import type {
  AssignShippingDefaultData,
  ClearShippingDefaultData,
  CreateShippingProfileData,
  ProductListingDeliveryCommandData,
  ReplaceShippingProfileData,
  ShippingImportWriteData,
  ShippingProfileLifecycleData,
} from "../generated/api/types.gen";
import {
  type MappedMembership,
  type MappedProfile,
  type Mapping,
  SHOPIFY_SHIPPING_INTEGRATION,
} from "./model";

export type PendingWrite =
  | { kind: "create"; body: CreateShippingProfileData }
  | { kind: "replace"; id: string; body: ReplaceShippingProfileData }
  | { kind: "restore"; id: string; body: ShippingProfileLifecycleData }
  | { kind: "retire"; id: string; body: ShippingProfileLifecycleData }
  | { kind: "default"; body: AssignShippingDefaultData }
  | { kind: "clearDefault"; body: ClearShippingDefaultData }
  | {
      kind: "membership";
      sourceListingId: string;
      body: ProductListingDeliveryCommandData;
    };

export interface ResourceMapping {
  id: string;
  providerId: string;
}
export interface PublishWork {
  key: string;
  resource:
    | { kind: "profile"; value: MappedProfile }
    | { kind: "membership"; value: MappedMembership }
    | { kind: "default"; objectKey: string | null }
    | { kind: "retire"; objectKey: string; id: string };
  pending?: PendingWrite;
  done?: boolean;
  failed?: boolean;
  preservedProfile?: boolean;
  attempts: number;
  dueAt: number;
}
export interface Publication {
  runId: string;
  sequence: number;
  acquiredAt: string;
  work: PublishWork[];
  mappings: Record<string, ResourceMapping>;
  committed: number;
  protected: number;
  failures: number;
  lastError?: string;
  reconcile: boolean;
}

export interface AuraShippingContext {
  apiBaseUrl: string;
  listingSourceId: string;
  accessToken: string;
}

export function beginPublication(
  mapping: Mapping,
  runId: string,
  sequence: number,
  acquiredAt: string,
  prior: Record<string, ResourceMapping>,
): Publication {
  const work: PublishWork[] = mapping.profiles.map((value) => ({
    key: value.objectKey,
    resource: { kind: "profile", value },
    attempts: 0,
    dueAt: 0,
  }));
  const defaults = mapping.profiles.filter((profile) => profile.isDefault);
  // Never select an ambiguous or unsupported default. Every product also has
  // an explicit selection, so incomplete membership cannot fall through here.
  work.push({
    key: "default",
    resource: {
      kind: "default",
      objectKey: defaults.length === 1 ? defaults[0].objectKey : null,
    },
    attempts: 0,
    dueAt: 0,
  });
  work.push(
    ...mapping.memberships.map(
      (value): PublishWork => ({
        key: `listing:${value.sourceListingId}`,
        resource: { kind: "membership", value },
        attempts: 0,
        dueAt: 0,
      }),
    ),
  );
  // Callers only reach this point after a complete, version-checked traversal.
  return {
    runId,
    sequence,
    acquiredAt,
    work,
    mappings: { ...prior },
    committed: 0,
    protected: 0,
    failures: 0,
    reconcile: false,
  };
}

export function addConfirmedRemovals(
  publication: Publication,
  observedObjectKeys: string[],
) {
  const observed = new Set(observedObjectKeys);
  for (const [objectKey, mapping] of Object.entries(publication.mappings)) {
    if (!observed.has(objectKey))
      publication.work.push({
        key: `retire:${objectKey}`,
        resource: { kind: "retire", objectKey, id: mapping.id },
        attempts: 0,
        dueAt: 0,
      });
  }
}

function metadata(
  publication: Publication,
  work: PublishWork,
  observation: boolean,
  suffix = "",
): ShippingImportWriteData {
  return {
    integration: SHOPIFY_SHIPPING_INTEGRATION,
    // Reserve two increasing positions per acquisition. An owned profile can
    // require a lifecycle restore before its observed terms are replaced.
    sequence: publication.sequence * 2 + (suffix === ":restore" ? 0 : 1),
    acquiredAt: publication.acquiredAt,
    requestKey: `${publication.runId}:${work.key}${suffix}`,
    ...(observation ? { observation: {} } : {}),
  };
}

function errorCode(result: { error?: unknown; response?: Response }) {
  const error = result.error;
  return error &&
    typeof error === "object" &&
    "error" in error &&
    typeof error.error === "string"
    ? error.error
    : error &&
        typeof error === "object" &&
        "code" in error &&
        typeof error.code === "string"
      ? error.code
      : `AURA_HTTP_${result.response?.status ?? "TRANSPORT"}`;
}

function fail(
  publication: Publication,
  work: PublishWork,
  result: { error?: unknown; response?: Response },
  now: number,
) {
  const code = errorCode(result);
  publication.lastError = code;
  if (code === "SHIPPING_IMPORT_OWNERSHIP_CONFLICT") {
    work.done = true;
    work.failed = true;
    work.preservedProfile =
      work.resource.kind === "profile" && work.pending?.kind === "replace";
    publication.protected++;
  } else if (result.response?.status === 409) {
    // No fresh expected revision or new acquisition timestamp on old content.
    // Reacquire the provider configuration through the common entry point.
    publication.reconcile = true;
  } else if (
    result.response?.status === 401 ||
    result.response?.status === 403 ||
    result.response?.status === 400
  ) {
    work.done = true;
    work.failed = true;
    publication.failures++;
  } else {
    work.attempts++;
    work.dueAt =
      now + Math.min(3600_000, 1000 * 2 ** Math.min(work.attempts, 12));
  }
}

export function readyPublicationWork(publication: Publication) {
  return publication.work.filter((work) => {
    if (work.done) return false;
    const resource = work.resource;
    const dependency =
      resource.kind === "membership"
        ? resource.value.profileObjectKey
        : resource.kind === "default"
          ? resource.objectKey
          : null;
    return (
      !dependency ||
      publication.work.some(
        (candidate) => candidate.key === dependency && candidate.done,
      )
    );
  });
}

// First persist the prepared request, then call this again to send it. A lost
// response, process restart or missing catalog record retains the exact body.
export async function publishShippingStep(
  publication: Publication,
  context: AuraShippingContext,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
) {
  const client = createClient({ baseUrl: context.apiBaseUrl, fetch: fetcher });
  const common = {
    client,
    headers: { Authorization: `Bearer ${context.accessToken}` },
  };
  const sourcePath = { listing_source_id: context.listingSourceId };
  const availableProfile = (objectKey: string | null) => {
    if (!objectKey) return undefined;
    const owner = publication.work.find(
      (item) => item.key === objectKey && item.resource.kind === "profile",
    );
    return owner?.done && (!owner.failed || owner.preservedProfile)
      ? publication.mappings[objectKey]
      : undefined;
  };
  const work = readyPublicationWork(publication).find(
    (candidate) => candidate.dueAt <= now,
  );
  if (!work) return;
  if (work.pending) {
    const pending = work.pending;
    const profilePath =
      "id" in pending
        ? { ...sourcePath, shipping_profile_id: pending.id }
        : null;
    const result =
      pending.kind === "create"
        ? await createShippingProfile({
            ...common,
            path: sourcePath,
            body: pending.body,
          })
        : pending.kind === "replace"
          ? await replaceShippingProfile({
              ...common,
              path: { ...sourcePath, shipping_profile_id: pending.id },
              body: pending.body,
            })
          : pending.kind === "restore" || pending.kind === "retire"
            ? await (pending.kind === "restore"
                ? restoreShippingProfile
                : retireShippingProfile)({
                ...common,
                path: profilePath as {
                  listing_source_id: string;
                  shipping_profile_id: string;
                },
                body: pending.body,
              })
            : pending.kind === "default"
              ? await assignShippingDefault({
                  ...common,
                  path: sourcePath,
                  body: pending.body,
                })
              : pending.kind === "clearDefault"
                ? await clearShippingDefault({
                    ...common,
                    path: sourcePath,
                    body: pending.body,
                  })
                : await changeProductListingDelivery({
                    ...common,
                    path: {
                      ...sourcePath,
                      source_listing_id: pending.sourceListingId,
                    },
                    body: pending.body,
                  });
    if (
      result.error === undefined &&
      (result.response?.status === 200 ||
        result.response?.status === 201 ||
        result.response?.status === 204)
    ) {
      if (work.resource.kind === "profile") {
        const data = result.data;
        if (data && "shippingProfileId" in data && data.shippingProfileId)
          publication.mappings[work.key] = {
            id: data.shippingProfileId,
            providerId: work.resource.value.providerId,
          };
      }
      if (pending.kind === "restore") {
        // The committed restore permits a new read for the subsequent replace.
        work.pending = undefined;
        return;
      }
      work.done = true;
      publication.committed++;
      if (work.resource.kind === "retire")
        delete publication.mappings[work.resource.objectKey];
    } else if (
      errorCode(result) === "SHIPPING_IMPORT_IDENTITY_EXISTS" &&
      pending.kind === "create"
    ) {
      // An earlier create committed. Resolve the stable object key next time.
      work.pending = undefined;
    } else fail(publication, work, result, now);
    return;
  }
  const resource = work.resource;
  if (resource.kind === "profile") {
    const result = await listShippingProfiles({
      ...common,
      path: sourcePath,
      query: {
        objectKey: resource.value.objectKey,
        integrationMethod: "SHOPIFY",
        size: 1,
      },
    });
    if (!result.data) {
      fail(publication, work, result, now);
      return;
    }
    const existing = result.data[0];
    const imported = {
      ...metadata(publication, work, true),
      objectKey: resource.value.objectKey,
    };
    if (!existing) {
      work.pending = {
        kind: "create",
        body: {
          creationKey: resource.value.objectKey,
          content: resource.value.content,
          evidence: [],
          import: imported,
        },
      };
    } else {
      publication.mappings[work.key] = {
        id: existing.shippingProfileId,
        providerId: resource.value.providerId,
      };
      work.pending =
        existing.lifecycle === "RETIRED"
          ? {
              kind: "restore",
              id: existing.shippingProfileId,
              body: {
                expectedRevision: existing.managementRevision,
                import: metadata(publication, work, false, ":restore"),
              },
            }
          : {
              kind: "replace",
              id: existing.shippingProfileId,
              body: {
                expectedRevision: existing.managementRevision,
                content: resource.value.content,
                evidence: [],
                import: imported,
              },
            };
    }
  } else if (resource.kind === "default") {
    const result = await getShippingDefault({ ...common, path: sourcePath });
    if (!result.data) {
      fail(publication, work, result, now);
      return;
    }
    const profile = availableProfile(resource.objectKey);
    if (resource.objectKey && !profile) {
      work.done = true;
      publication.failures++;
      return;
    }
    work.pending = profile
      ? {
          kind: "default",
          body: {
            expectedRevision: result.data.revision,
            shippingProfileId: profile.id,
            import: metadata(publication, work, true),
          },
        }
      : {
          kind: "clearDefault",
          body: {
            expectedRevision: result.data.revision,
            import: metadata(publication, work, false),
          },
        };
  } else if (resource.kind === "membership") {
    const result = await getProductListingDelivery({
      ...common,
      path: {
        ...sourcePath,
        source_listing_id: resource.value.sourceListingId,
      },
    });
    if (!result.data) {
      fail(publication, work, result, now);
      return;
    }
    const profile = availableProfile(resource.value.profileObjectKey);
    // A failed profile create never becomes permission to inherit a default.
    work.pending = {
      kind: "membership",
      sourceListingId: resource.value.sourceListingId,
      body: {
        expectedVersion: result.data.expectedVersion,
        import: metadata(publication, work, true),
        delivery: {
          state: "SET",
          value: {
            integration: SHOPIFY_SHIPPING_INTEGRATION,
            selection: {
              state: "SET",
              value: profile
                ? { kind: "EXPLICIT", profile_id: profile.id }
                : { kind: "SUPPRESS_INHERITANCE" },
            },
            rateInputs: {
              state: "SET",
              value: { classes: null, variants: resource.value.variants },
            },
            shipping: { state: "UNCHANGED" },
            collection: { state: "UNCHANGED" },
          },
        },
      },
    };
  } else {
    const result = await getShippingProfile({
      ...common,
      path: { ...sourcePath, shipping_profile_id: resource.id },
    });
    if (!result.data) {
      fail(publication, work, result, now);
      return;
    }
    work.pending = {
      kind: "retire",
      id: resource.id,
      body: {
        expectedRevision: result.data.managementRevision,
        import: metadata(publication, work, false),
      },
    };
  }
}
