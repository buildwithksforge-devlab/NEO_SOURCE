/**
 * Phase 4 — Guest CRM data layer.
 *
 * Every read and write goes through the tenant-scoped Supabase tables created
 * in the Phase 4 migration. Nothing here fabricates operational data: modules
 * that do not exist yet (reservations, folios, payments) simply have no rows,
 * and the UI renders an explicit "awaiting data" state instead.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export const CUSTOMER_TYPES = [
  "individual-guest",
  "restaurant-customer",
  "delivery-customer",
  "event-client",
  "corporate-contact",
  "corporate-account",
  "credit-client",
  "tour-operator-contact",
  "government-contact",
  "ngo-contact",
  "school-contact",
  "hospital-contact",
] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const CORPORATE_TYPES = [
  "company",
  "government",
  "ngo",
  "school",
  "hospital",
  "tour-company",
  "travel-agency",
  "conference-organizer",
  "other",
] as const;

export const PREFERENCE_CATEGORIES = {
  accommodation: [
    "Preferred room",
    "Preferred room type",
    "Preferred floor",
    "Bed type",
    "Pillow preference",
    "Smoking preference",
    "Quiet room",
    "Accessibility requirement",
  ],
  dining: [
    "Favourite meal",
    "Favourite drink",
    "Dietary requirement",
    "Allergy",
    "Spice preference",
    "Seating preference",
  ],
  service: [
    "Preferred payment method",
    "Preferred communication channel",
    "Preferred language",
    "Check-in preference",
    "Transfer preference",
    "Excursion interest",
  ],
} as const;

export type PreferenceCategory = keyof typeof PREFERENCE_CATEGORIES;

export const FEEDBACK_TYPES = [
  "review",
  "complaint",
  "compliment",
  "suggestion",
  "service-recovery",
  "internal-follow-up",
] as const;

export const FEEDBACK_STATUSES = [
  "new",
  "acknowledged",
  "assigned",
  "investigating",
  "waiting-customer",
  "resolved",
  "closed",
  "reopened",
] as const;

export const FEEDBACK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export const COMMUNICATION_CHANNELS = [
  "in-system",
  "email",
  "whatsapp",
  "sms",
  "phone-call",
  "walk-in",
] as const;

export const CONSENT_TYPES = [
  "essential-service",
  "email-marketing",
  "sms-marketing",
  "whatsapp-marketing",
  "push-notifications",
  "personalization",
] as const;

export const CREDIT_STATUSES = ["active", "on-hold", "suspended", "closed"] as const;

export function titleCase(value: string) {
  return value
    .split(/[-_]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/** Identity document numbers are never shown in full outside the restricted section. */
export function maskDocument(value: string) {
  const clean = value.replace(/\s/g, "");
  if (clean.length <= 4) return "••••";
  return `${"•".repeat(Math.max(clean.length - 4, 3))}${clean.slice(-4)}`;
}

export function customerNumber() {
  const now = new Date();
  const rand = Math.floor(Math.random() * 100000)
    .toString()
    .padStart(5, "0");
  return `CUS-${now.getFullYear()}-${rand}`;
}

export function referenceFor(prefix: string) {
  const rand = Math.floor(Math.random() * 100000)
    .toString()
    .padStart(5, "0");
  return `${prefix}-${new Date().getFullYear()}-${rand}`;
}

export type Customer = {
  id: string;
  organization_id: string;
  primary_branch_id: string | null;
  auth_user_id: string | null;
  customer_number: string;
  customer_type: string;
  full_name: string;
  preferred_name: string;
  nationality: string;
  date_of_birth: string | null;
  anniversary_date: string | null;
  phone: string;
  alt_phone: string;
  email: string;
  address: string;
  city: string;
  country: string;
  occupation: string;
  company: string;
  job_title: string;
  preferred_language: string;
  corporate_account_id: string | null;
  account_manager_id: string | null;
  is_vip: boolean;
  vip_notes: string;
  account_status: string;
  marketing_consent: boolean;
  source: string;
  last_interaction_at: string | null;
  archived_at: string | null;
  merged_into_id: string | null;
  /** Guest app account state: none | invited | active | suspended. */
  guest_account_status?: string | null;
  guest_linked_at?: string | null;
  guest_link_method?: string | null;
  guest_invited_at?: string | null;
  last_guest_app_activity_at?: string | null;
  created_at: string;
  updated_at: string;
};

const table = (name: string) => supabase.from(name as never);

export type CustomerFilters = {
  search?: string | undefined;
  type?: string | undefined;
  vip?: boolean | undefined;
  status?: string | undefined;
  branchId?: string | null | undefined;
};

export function useCustomers(filters?: CustomerFilters) {
  return useQuery({
    queryKey: ["crm-customers", filters],
    queryFn: async () => {
      let q = supabase
        .from("customers")
        .select("*")
        .is("merged_into_id", null)
        .order("created_at", { ascending: false })
        .limit(500);
      if (filters?.type) q = q.eq("customer_type", filters.type);
      if (filters?.vip) q = q.eq("is_vip", true);
      if (filters?.status) q = q.eq("account_status", filters.status);
      if (filters?.branchId) q = q.eq("primary_branch_id", filters.branchId);
      if (filters?.search) {
        const s = `%${filters.search}%`;
        q = q.or(
          `full_name.ilike.${s},email.ilike.${s},phone.ilike.${s},customer_number.ilike.${s},company.ilike.${s}`,
        );
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Customer[];
    },
  });
}

export function useCustomer(id: string) {
  return useQuery({
    queryKey: ["crm-customer", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase.from("customers").select("*").eq("id", id).maybeSingle();
      if (error) throw error;
      return (data ?? null) as unknown as Customer | null;
    },
  });
}

/** Generic child-record reader used by the customer profile tabs. */
export function useCustomerChildren<T = Record<string, unknown>>(
  tableName: string,
  customerId: string,
  orderColumn = "created_at",
) {
  return useQuery({
    queryKey: ["crm-child", tableName, customerId],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await table(tableName)
        .select("*")
        .eq("customer_id", customerId)
        .order(orderColumn, { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as T[];
    },
  });
}

export function useCorporateAccounts() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["crm-corporate", filterKey],
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("corporate_accounts").select("*, corporate_credit_settings(*), corporate_contacts(*)"), "corporate_accounts")
        .order("legal_name");
      if (error) throw error;
      return (data ?? []) as unknown as Record<string, never>[];
    },
  });
}

export function useLoyaltyProgram() {
  return useQuery({
    queryKey: ["crm-loyalty-program"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loyalty_programs")
        .select("*, loyalty_tiers(*)")
        .order("created_at")
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as unknown as Record<string, never> | null;
    },
  });
}

export function useLoyaltyAccounts() {
  return useQuery({
    queryKey: ["crm-loyalty-accounts"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("loyalty_accounts")
        .select("*, customers(full_name, customer_number), loyalty_tiers(name)")
        .order("points_available", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Record<string, never>[];
    },
  });
}

export function useFeedback(filters?: {
  status?: string | undefined;
  type?: string | undefined;
  mine?: string | null | undefined;
}) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["crm-feedback", filters, filterKey],
    queryFn: async () => {
      let q = applyTo(supabase.from("customer_feedback").select("*, customers(full_name, customer_number)"), "customer_feedback")
        .order("received_at", { ascending: false });
      if (filters?.status) q = q.eq("status", filters.status);
      if (filters?.type) q = q.eq("feedback_type", filters.type);
      if (filters?.mine) q = q.eq("assigned_user_id", filters.mine);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Record<string, never>[];
    },
  });
}

export function useCommunications(customerId?: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["crm-communications", customerId ?? "all", filterKey],
    queryFn: async () => {
      let q = applyTo(supabase.from("customer_communications").select("*, customers(full_name, customer_number)"), "customer_communications")
        .order("occurred_at", { ascending: false })
        .limit(300);
      if (customerId) q = q.eq("customer_id", customerId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Record<string, never>[];
    },
  });
}

export function useSegments() {
  return useQuery({
    queryKey: ["crm-segments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customer_segments")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Record<string, never>[];
    },
  });
}

/**
 * Duplicate matching vocabulary.
 *
 * A duplicate is only ever proposed on a meaningful, normalised identifier.
 * Blank, null and placeholder values (single letters, obvious junk) are never
 * identifiers, so two profiles that simply have no email or no phone can never
 * be grouped together. Nothing is merged automatically.
 */
const PLACEHOLDER_VALUES = new Set([
  "n/a",
  "na",
  "none",
  "null",
  "nil",
  "test",
  "tests",
  "unknown",
  "guest",
  "walkin",
  "walk-in",
  "no email",
  "noemail",
  "nophone",
  "xxx",
  "abc",
  "asdf",
  "qwerty",
  "-",
  "--",
  ".",
  "..",
]);

const isPlaceholder = (value: string) =>
  PLACEHOLDER_VALUES.has(value) || /^(.)\1*$/.test(value.replace(/[\s.]/g, ""));

/** A usable email identifier, or null when the value cannot identify a person. */
export function normalizeEmailIdentifier(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value || isPlaceholder(value)) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)) return null;
  const local = value.split("@")[0] ?? "";
  if (local.length < 2 || isPlaceholder(local)) return null;
  return value;
}

/**
 * A usable phone identifier. Numbers are reduced to their national significant
 * digits (the last nine) so `+254712345678` and `0712345678` are the same
 * person, while short or repeated junk is refused.
 */
export function normalizePhoneIdentifier(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 9) return null;
  const national = digits.slice(-9);
  if (/^(\d)\1*$/.test(national)) return null;
  if (/^0+$/.test(national)) return null;
  return national;
}

/** A strong name identifier: two real name parts, no placeholder junk. */
export function normalizeNameIdentifier(raw: string | null | undefined): string | null {
  const value = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!value || isPlaceholder(value)) return null;
  const parts = value.split(" ").filter((p) => p.length >= 2 && !isPlaceholder(p));
  if (parts.length < 2) return null;
  const joined = parts.sort().join(" ");
  if (joined.replace(/\s/g, "").length < 6) return null;
  return joined;
}

/** A birth date is only an identifier when it is a real, plausible date. */
export function normalizeDobIdentifier(raw: string | null | undefined): string | null {
  const value = (raw ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  if (year < 1900 || year > new Date().getFullYear()) return null;
  return value;
}

export type DuplicateGroup = { reason: "email" | "phone" | "name"; customers: Customer[] };

/**
 * Pure matching routine — shared by the screen and by the regression tests so
 * the rule that is tested is the rule that runs.
 */
export function computeDuplicateGroups(rows: Customer[]): DuplicateGroup[] {
  const buckets = new Map<string, Customer[]>();
  const push = (key: string | null, row: Customer) => {
    if (!key) return;
    const list = buckets.get(key) ?? [];
    list.push(row);
    buckets.set(key, list);
  };

  for (const row of rows) {
    if (row.merged_into_id) continue;
    const email = normalizeEmailIdentifier(row.email);
    if (email) push(`email:${email}`, row);
    const phone = normalizePhoneIdentifier(row.phone);
    if (phone) push(`phone:${phone}`, row);
    const name = normalizeNameIdentifier(row.full_name);
    const dob = normalizeDobIdentifier(row.date_of_birth);
    // A shared name alone is never enough: the birth date must be present on
    // both records for a name match to be proposed.
    if (name && dob) push(`name:${name}|${dob}`, row);
  }

  const seen = new Set<string>();
  const groups: DuplicateGroup[] = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    const ids = list
      .map((c) => c.id)
      .sort()
      .join("|");
    if (seen.has(ids)) continue;
    seen.add(ids);
    groups.push({ reason: (key.split(":")[0] ?? "email") as DuplicateGroup["reason"], customers: list });
  }
  return groups;
}

/** Possible duplicates detected on a shared email, phone or name + birth date. */
export function useDuplicateCandidates() {
  return useQuery({
    queryKey: ["crm-duplicates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("*")
        .is("merged_into_id", null)
        .limit(1000);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Customer[];
      return computeDuplicateGroups(rows);

    },
  });
}

export function useCrmMetrics() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["crm-metrics", filterKey],
    refetchInterval: 120_000,
    queryFn: async () => {
      const [customers, corporates, loyalty, feedback, comms] = await Promise.all([
        supabase.from("customers").select("*").is("merged_into_id", null).limit(2000),
        applyTo(supabase.from("corporate_accounts").select("id, account_status"), "corporate_accounts").limit(1000),
        supabase.from("loyalty_accounts").select("id, status, points_available").limit(2000),
        applyTo(supabase.from("customer_feedback").select("id, status, feedback_type, rating, received_at, resolution_due_at, resolved_at"), "customer_feedback")
          .limit(2000),
        applyTo(supabase.from("customer_communications").select("id, delivery_status"), "customer_communications").limit(2000),
      ]);
      const rows = (customers.data ?? []) as unknown as Customer[];
      const now = new Date();
      const soon = (d: string | null) => {
        if (!d) return false;
        const date = new Date(d);
        const next = new Date(now.getFullYear(), date.getMonth(), date.getDate());
        const diff = (next.getTime() - now.getTime()) / 86_400_000;
        return diff >= -1 && diff <= 30;
      };
      const fb = (feedback.data ?? []) as { status: string; rating: number | null; resolution_due_at: string | null; resolved_at: string | null }[];
      const ratings = fb.map((f) => f.rating).filter((r): r is number => typeof r === "number");
      return {
        totalCustomers: rows.length,
        newCustomers: rows.filter(
          (c) => new Date(c.created_at).getTime() > now.getTime() - 30 * 86_400_000,
        ).length,
        vip: rows.filter((c) => c.is_vip).length,
        inactive: rows.filter(
          (c) =>
            !c.last_interaction_at ||
            new Date(c.last_interaction_at).getTime() < now.getTime() - 180 * 86_400_000,
        ).length,
        optIn: rows.length ? Math.round((rows.filter((c) => c.marketing_consent).length / rows.length) * 100) : 0,
        birthdays: rows.filter((c) => soon(c.date_of_birth)),
        anniversaries: rows.filter((c) => soon(c.anniversary_date)),
        corporateAccounts: (corporates.data ?? []).length,
        loyaltyMembers: ((loyalty.data ?? []) as { status: string }[]).filter((l) => l.status === "active").length,
        openComplaints: fb.filter((f) => !["resolved", "closed"].includes(f.status)).length,
        overdueComplaints: fb.filter(
          (f) =>
            !["resolved", "closed"].includes(f.status) &&
            f.resolution_due_at !== null &&
            new Date(f.resolution_due_at) < now,
        ).length,
        satisfaction: ratings.length
          ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10
          : null,
        failedComms: ((comms.data ?? []) as { delivery_status: string }[]).filter(
          (c) => c.delivery_status === "failed",
        ).length,
        recentCustomers: rows.slice(0, 8),
        typeBreakdown: CUSTOMER_TYPES.map((t) => ({
          type: titleCase(t),
          count: rows.filter((c) => c.customer_type === t).length,
        })).filter((r) => r.count > 0),
        growth: Array.from({ length: 6 }, (_, i) => {
          const month = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
          const next = new Date(now.getFullYear(), now.getMonth() - (4 - i), 1);
          return {
            month: month.toLocaleDateString(undefined, { month: "short" }),
            customers: rows.filter((c) => {
              const t = new Date(c.created_at);
              return t >= month && t < next;
            }).length,
          };
        }),
      };
    },
  });
}

export function useInvalidateCrm() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["crm-customers"] });
    void qc.invalidateQueries({ queryKey: ["crm-customer"] });
    void qc.invalidateQueries({ queryKey: ["crm-child"] });
    void qc.invalidateQueries({ queryKey: ["crm-metrics"] });
    void qc.invalidateQueries({ queryKey: ["crm-corporate"] });
    void qc.invalidateQueries({ queryKey: ["crm-feedback"] });
    void qc.invalidateQueries({ queryKey: ["crm-loyalty-accounts"] });
    void qc.invalidateQueries({ queryKey: ["crm-communications"] });
    void qc.invalidateQueries({ queryKey: ["crm-segments"] });
    void qc.invalidateQueries({ queryKey: ["crm-duplicates"] });
  };
}

/** Timeline events are generated from CRM actions, never hand-duplicated transactions. */
export async function recordTimelineEvent(input: {
  organizationId: string;
  customerId: string;
  eventType: string;
  description: string;
  sourceModule?: string;
  sourceRecordId?: string | null;
  staffUserId?: string | null;
  customerVisible?: boolean;
  branchId?: string | null;
}) {
  await supabase.from("customer_timeline_events").insert({
    organization_id: input.organizationId,
    customer_id: input.customerId,
    event_type: input.eventType,
    description: input.description,
    source_module: input.sourceModule ?? "crm",
    source_record_id: input.sourceRecordId ?? null,
    staff_user_id: input.staffUserId ?? null,
    customer_visible: input.customerVisible ?? false,
    branch_id: input.branchId ?? null,
  });
}
