/**
 * Authentication e-mail metadata contract.
 *
 * Supabase renders the branded confirmation template with whatever lives in
 * `raw_user_meta_data`, so every account-creation path must supply the same
 * shape. These builders are the single source of that shape: they normalise
 * values, drop anything empty and — critically — never emit internal
 * identifiers (user ids, organisation ids, branch ids, keys) or private tenant
 * contact data into an e-mail payload.
 *
 * Every field is optional at render time; the template carries fallbacks.
 */

/** Keys the branded auth templates are allowed to read. */
export const AUTH_EMAIL_METADATA_KEYS = [
  "full_name",
  "organisation_name",
  "property_name",
  "role_title",
  "invited_by_name",
  "account_type",
] as const;

export type AuthEmailMetadataKey = (typeof AUTH_EMAIL_METADATA_KEYS)[number];

export type AuthEmailMetadata = Partial<Record<AuthEmailMetadataKey, string>>;

const MAX_LENGTH = 120;

/** Anything resembling an identifier or secret is refused outright. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  if (UUID.test(trimmed)) return undefined;
  return trimmed.slice(0, MAX_LENGTH);
}

type MetadataDraft = { [K in AuthEmailMetadataKey]?: string | undefined };

function compact(input: MetadataDraft): AuthEmailMetadata {
  const out: AuthEmailMetadata = {};
  for (const key of AUTH_EMAIL_METADATA_KEYS) {
    const value = clean(input[key]);
    if (value) out[key] = value;
  }
  return out;
}

export type StaffInviteMetadataInput = {
  full_name?: string | null;
  organisation_name?: string | null;
  property_name?: string | null;
  role_title?: string | null;
  job_title?: string | null;
  invited_by_name?: string | null;
};

/**
 * Staff invite / worker provisioning.
 *
 * `role_title` prefers the assigned role, falling back to the recorded job
 * title so the recipient always understands why the account exists.
 */
export function buildStaffInviteMetadata(input: StaffInviteMetadataInput): AuthEmailMetadata {
  return compact({
    full_name: input.full_name ?? undefined,
    organisation_name: input.organisation_name ?? undefined,
    property_name: input.property_name ?? undefined,
    role_title: input.role_title ?? input.job_title ?? undefined,
    invited_by_name: input.invited_by_name ?? undefined,
    account_type: "staff",
  });
}

export type CustomerSignupMetadataInput = {
  full_name?: string | null;
  organisation_name?: string | null;
  property_name?: string | null;
};

/**
 * Public customer sign-up.
 *
 * Customers have no role, no inviter and no internal placement, so staff-only
 * fields are never assumed — only the guest's own name and the public brand
 * they signed up with.
 */
export function buildCustomerSignupMetadata(input: CustomerSignupMetadataInput): AuthEmailMetadata {
  return compact({
    full_name: input.full_name ?? undefined,
    organisation_name: input.organisation_name ?? undefined,
    property_name: input.property_name ?? undefined,
    account_type: "customer",
  });
}

export type WorkspaceOwnerMetadataInput = {
  full_name?: string | null;
  organisation_name?: string | null;
  role_title?: string | null;
};

/** Self-service workspace creation: the signer-up is their own organisation. */
export function buildWorkspaceOwnerMetadata(input: WorkspaceOwnerMetadataInput): AuthEmailMetadata {
  return compact({
    full_name: input.full_name ?? undefined,
    organisation_name: input.organisation_name ?? undefined,
    role_title: input.role_title ?? undefined,
    account_type: "owner",
  });
}
