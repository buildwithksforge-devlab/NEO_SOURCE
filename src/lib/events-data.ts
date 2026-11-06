import { guardedRpc } from "@/lib/rpc-guard";
import { useCallback, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import type { Row } from "@/lib/events";

const sel = (s: string): string => s;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/**
 * Every events table that physically belongs to one property. Records in these
 * tables are always read and written against the selected property â€” never the
 * signing-in user's home branch, which is null for organisation-wide accounts.
 */
export const EVENT_PROPERTY_TABLES = new Set<string>([
  "event_bookings",
  "event_enquiries",
  "event_quotations",
  "event_venues",
  "event_resources",
  "event_packages",
  "site_visits",
  "venue_blocks",
]);

/**
 * Events context. The property comes from the global property selector, so the
 * module always agrees with the header â€” including for organisation-wide users
 * whose profile carries no branch at all.
 */
export function useEventsCtx() {
  const { organizationId, profile, user } = useAuth();
  const { branchId, orgWide } = useActivePropertyFilter();
  return {
    organizationId,
    branchId,
    orgWide,
    allProperties: branchId === null,
    userId: user?.id ?? null,
    userName: (profile as { full_name?: string } | null)?.full_name ?? "",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Builder = any;

function useList(key: string, table: string, select: string, build?: (q: Builder) => Builder) {
  const { organizationId, branchId } = useEventsCtx();
  return useQuery({
    queryKey: ["events", key, organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q: Builder = db.from(table).select(sel(select));
      if (branchId && EVENT_PROPERTY_TABLES.has(table)) q = q.eq("branch_id", branchId);
      if (build) q = build(q);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}


/* ------------------------------- reads ------------------------------- */

export function useEventsMetrics(branchOverride?: string | null) {
  const { organizationId, branchId } = useEventsCtx();
  const branch = branchOverride === undefined ? branchId : branchOverride;
  return useQuery({
    queryKey: ["events", "metrics", organizationId, branch],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "events_metrics", { _branch: branch });
      if (error) throw error;
      return (data ?? {}) as Record<string, number>;
    },
  });
}

/**
 * The authoritative events workspace. One scoped read model behind the
 * dashboard, calendar, bookings list, readiness board, billing and reports, so
 * every screen counts the same events for the same property.
 */
export type EventWorkspaceRow = {
  booking_id: string;
  event_reference: string;
  event_name: string | null;
  status: string;
  payment_status: string | null;
  event_date: string;
  start_at: string;
  end_at: string;
  setup_at: string | null;
  breakdown_at: string | null;
  branch_id: string;
  branch_name: string | null;
  venue_id: string | null;
  venue_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  corporate_account_id: string | null;
  event_type_id: string | null;
  event_type_name: string | null;
  coordinator_id: string | null;
  quotation_id: string | null;
  quotation_number: string | null;
  enquiry_id: string | null;
  enquiry_number: string | null;
  expected_guests: number | null;
  guaranteed_guests: number | null;
  final_guests: number | null;
  /** Financial rollups are null unless the caller holds events.billing.view. */
  total_amount: number | null;
  paid_amount: number | null;
  balance_due: number | null;
  deposit_required: number | null;
  deposit_paid: number | null;
  /** Readiness rollups are null unless the caller holds events.readiness.view. */
  readiness_total: number | null;
  readiness_ready: number | null;
  readiness_blocked: number | null;
  billing_items: number | null;
  billing_total: number | null;
  /** Null unless the caller holds events.resources.view. */
  resource_reservations: number | null;
  /** Null unless the caller holds events.feedback.view. */
  feedback_responses: number | null;
  feedback_avg: number | null;
  beo_status: string | null;
  created_at: string;
};

export function useEventWorkspace(range?: { from?: string | null; to?: string | null }) {
  const { organizationId, branchId } = useEventsCtx();
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  return useQuery({
    queryKey: ["events", "workspace", organizationId, branchId, from, to],
    enabled: Boolean(organizationId),
    // Rapid month navigation must not leave a stale in-flight response to win:
    // the previous month's rows stay on screen (so day states do not flash
    // empty) while the superseded request is aborted.
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const { data, error } = await db
        .rpc("neo_event_workspace", {
          _branch: branchId,
          _from: from,
          _to: to,
        })
        .abortSignal(signal);
      if (error) throw error;
      return (data ?? []) as EventWorkspaceRow[];
    },
  });
}

export type EventBillingRow = {
  booking_id: string;
  event_reference: string;
  event_name: string | null;
  status: string;
  payment_status: string | null;
  event_date: string;
  branch_id: string;
  branch_name: string | null;
  customer_name: string | null;
  total_amount: number;
  paid_amount: number;
  balance_due: number;
  deposit_required: number;
  deposit_paid: number;
  billing_items: number;
  billing_total: number;
};

/** Thin, permission-gated financial projection over the same event records. */
export function useEventBilling(range?: { from?: string | null; to?: string | null }) {
  const { organizationId, branchId } = useEventsCtx();
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  return useQuery({
    queryKey: ["events", "billing", organizationId, branchId, from, to],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_event_billing", { _branch: branchId, _from: from, _to: to });
      if (error) throw error;
      return (data ?? []) as EventBillingRow[];
    },
  });
}

export function useEventReports(range?: { from?: string | null; to?: string | null }) {
  const { organizationId, branchId } = useEventsCtx();
  const from = range?.from ?? null;
  const to = range?.to ?? null;
  return useQuery({
    queryKey: ["events", "reports", organizationId, branchId, from, to],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_event_reports", { _branch: branchId, _from: from, _to: to });
      if (error) throw error;
      return (data ?? {}) as Row;
    },
  });
}


export function useEventTypes() {
  return useList(
    "types",
    "event_types",
    "id, key, name, category, description, default_service_style, active, sort_order",
    (q) => q.order("sort_order").order("name"),
  );
}

export function useVenues() {
  return useList(
    "venues",
    "event_venues",
    "id, name, code, branch_id, description, location, is_outdoor, min_capacity, max_capacity, layouts, base_hire_price, tax_rate, setup_minutes, breakdown_minutes, opens_at, closes_at, facilities, accessibility, status, maintenance_note",
    (q) => q.order("name"),
  );
}

export function useVenueBlocks() {
  return useList(
    "venue-blocks",
    "venue_blocks",
    "id, venue_id, booking_id, block_type, starts_at, ends_at, status, reason, override_reason, event_venues(name), event_bookings(event_reference, event_name)",
    (q) => q.neq("status", "released").order("starts_at"),
  );
}

export function useResources() {
  return useList(
    "resources",
    "event_resources",
    "id, name, category, branch_id, quantity_owned, condition, location, hire_price, maintenance_status, active",
    (q) => q.order("category").order("name"),
  );
}

export function useResourceReservations() {
  return useList(
    "resource-reservations",
    "event_resource_reservations",
    "id, resource_id, booking_id, quantity, starts_at, ends_at, status, notes, event_resources(name, quantity_owned), event_bookings(event_reference)",
    (q) => q.neq("status", "released").order("starts_at"),
  );
}

export function usePackages() {
  return useList(
    "packages",
    "event_packages",
    "id, name, description, branch_id, event_type_id, price_basis, price, min_guests, max_guests, exclusions, tax_rate, valid_from, valid_to, active, event_types(name), event_package_items(id, component, description, quantity, unit_price, is_optional)",
    (q) => q.order("name"),
  );
}

export function useEnquiries() {
  return useList(
    "enquiries",
    "event_enquiries",
    "id, enquiry_number, contact_name, phone, email, preferred_channel, event_type_label, proposed_date, alternative_date, start_time, end_time, expected_adults, expected_children, estimated_budget, requirements, internal_notes, lead_source, next_followup_at, probability, status, loss_reason, competitor, venue_id, customer_id, corporate_account_id, branch_id, created_at, customers(full_name, customer_number), event_venues(name)",
    (q) => q.order("created_at", { ascending: false }).limit(300),
  );
}

export function useSiteVisits() {
  return useList(
    "site-visits",
    "site_visits",
    "id, visit_at, status, attendees, client_requirements, preparation_notes, outcome, next_action, followup_at, enquiry_id, venue_id, customer_id, event_enquiries(enquiry_number, contact_name), event_venues(name)",
    (q) => q.order("visit_at", { ascending: false }).limit(200),
  );
}

export function useQuotations() {
  return useList(
    "quotations",
    "event_quotations",
    "id, quotation_number, version, title, status, event_date, start_time, end_time, guest_count, currency, subtotal, discount_amount, service_charge_rate, service_charge_amount, tax_rate, tax_amount, grand_total, deposit_percent, deposit_amount, balance_due, valid_until, client_notes, internal_notes, terms, sent_at, responded_at, accepted_by_name, enquiry_id, customer_id, corporate_account_id, venue_id, package_id, created_at, customers(full_name), event_venues(name), event_quotation_items(id, category, description, quantity, unit, unit_price, line_total, taxable, unit_cost, sort_order)",
    (q) => q.order("created_at", { ascending: false }).limit(200),
  );
}

export function useBookings() {
  return useList(
    "bookings",
    "event_bookings",
    "id, event_reference, event_name, status, payment_status, event_date, start_at, end_at, setup_at, breakdown_at, expected_guests, guaranteed_guests, final_guests, adults, children, service_style, seating_layout, colour_theme, vip_details, dietary_requirements, allergy_warnings, photography_consent, deposit_required, deposit_paid, total_amount, paid_amount, hold_expires_at, cancellation_reason, internal_notes, venue_id, customer_id, corporate_account_id, quotation_id, branch_id, created_at, customers(full_name, phone), event_venues(name, max_capacity), event_types(name)",
    (q) => q.order("event_date", { ascending: false }).limit(300),
  );
}

export function useBooking(id: string | null) {
  const { organizationId } = useEventsCtx();
  return useQuery({
    queryKey: ["events", "booking", id, organizationId],
    enabled: Boolean(id && organizationId),
    queryFn: async () => {
      const q: Builder = db
        .from("event_bookings")
        .select(
          sel(
            "*, customers(full_name, phone, email, customer_number, is_vip), event_venues(name, max_capacity, layouts), event_types(name), corporate_accounts(legal_name, account_number)",
          ),
        );
      const { data, error } = await q.eq("id", id).maybeSingle();
      if (error) throw error;
      return (data ?? null) as Row | null;
    },
  });
}

function useChild(key: string, table: string, select: string, bookingId: string | null, order = "created_at") {
  return useQuery({
    queryKey: ["events", key, bookingId],
    enabled: Boolean(bookingId),
    queryFn: async () => {
      const q: Builder = db.from(table).select(sel(select));
      const { data, error } = await q.eq("booking_id", bookingId).order(order);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

export const useMilestones = (b: string | null) =>
  useChild("milestones", "event_milestones", "id, key, label, due_at, completed_at, notes, sort_order", b, "sort_order");

export const useDepartmentRequirements = (b: string | null) =>
  useChild(
    "dept-requirements",
    "event_department_requirements",
    "id, department_id, department_key, requirement, detail, required_by, readiness, blocker, task_id, departments(name)",
    b,
  );

export const useEventMenus = (b: string | null) =>
  useChild(
    "menus",
    "event_menus",
    "id, name, service_style, service_at, guest_count, price_per_person, estimated_cost, dietary_substitutions, allergens, version, approved_at, event_menu_items(id, course, name, portions, notes)",
    b,
  );

export const useBeos = (b: string | null) =>
  useChild(
    "beos",
    "banquet_event_orders",
    "id, beo_number, revision, status, change_summary, setup_at, guest_arrival_at, start_at, serving_times, end_at, breakdown_at, guaranteed_guests, final_guests, seating_layout, menu_summary, beverage_service, dietary_requirements, allergies, equipment, decor, entertainment, accommodation, transport, security, billing_instructions, emergency_contacts, published_at, locked",
    b,
    "revision",
  );

export const useBillingItems = (b: string | null) =>
  useChild(
    "billing",
    "event_billing_items",
    "id, category, description, quantity, unit_price, line_total, unit_cost, tax_rate, is_complimentary",
    b,
  );

export const useEventRequirements = (b: string | null) =>
  useChild(
    "requirements",
    "event_requirements",
    "id, description, unit, planned_qty, reserved_qty, issued_qty, consumed_qty, returned_qty, wasted_qty, required_at, status, stock_items(name)",
    b,
  );

export const useEventRoomBlocks = (b: string | null) =>
  useChild(
    "room-blocks",
    "event_room_blocks",
    "id, rooms_blocked, rooms_picked_up, occupancy, arrival_date, departure_date, meal_plan, billing_route, release_date, notes, room_types(name)",
    b,
  );

export const useEventActivity = (b: string | null) =>
  useChild("activity", "event_activity_logs", "id, action, detail, created_at", b, "created_at");

export function useEventFeedback() {
  return useList(
    "feedback",
    "event_feedback",
    "id, booking_id, rating_overall, rating_food, rating_service, rating_venue, comments, sentiment, resolution_status, response, created_at, event_bookings(event_reference, event_name), customers(full_name)",
    (q) => q.order("created_at", { ascending: false }).limit(100),
  );
}

export function useReadinessBoard(bookingId: string | null = null) {
  const { organizationId } = useEventsCtx();
  return useQuery({
    queryKey: ["events", "readiness", organizationId, bookingId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "events_department_readiness", { _booking: bookingId });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

export function useCustomersLite() {
  return useList("customers-lite", "customers", "id, full_name, customer_number, phone, email", (q) =>
    q.eq("account_status", "active").order("full_name").limit(500),
  );
}

export function useDepartmentsLite() {
  return useList("departments-lite", "departments", "id, name", (q) => q.order("name"));
}

export function useCorporateAccountsLite() {
  return useList("corporate-lite", "corporate_accounts", "id, legal_name, account_number", (q) =>
    q.order("legal_name"),
  );
}

/* ------------------------------ mutations ------------------------------ */

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["events"] });
}

/**
 * Normalise what a form hands over before it reaches the database.
 *
 * A cleared date, time or follow-up arrives as an empty string, which a date
 * column refuses; an untouched optional field should simply be absent rather
 * than blank. Strings are trimmed, blanks become nulls, and nothing else is
 * altered â€” no value is ever invented here.
 */
export function sanitizeEventValues(values: Row): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      out[key] = trimmed === "" ? null : trimmed;
    } else if (value === undefined) {
      out[key] = null;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export const PROPERTY_REQUIRED_MESSAGE =
  "Select a property in the header before creating this record â€” â€œAll Propertiesâ€ is a viewing mode only.";

/**
 * Generic insert used by the events forms. Property-bound records always take
 * the property currently selected in the header, and are refused outright while
 * the workspace is showing every property, so no event record can be orphaned.
 */
export function useEventInsert(table: string, label: string) {
  const { organizationId, branchId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (values: Row) => {
      // Boxes left blank are omitted rather than written as empty values, so the
      // stored record keeps its own default instead of being rejected outright.
      const cleaned = sanitizeEventValues(values);
      const payload: Row = { organization_id: organizationId };
      for (const [key, value] of Object.entries(cleaned)) {
        if (value !== null) payload[key] = value;
      }

      if (EVENT_PROPERTY_TABLES.has(table)) {
        const chosen = (values["branch_id"] as string | undefined) ?? branchId;
        if (!chosen) throw new Error(PROPERTY_REQUIRED_MESSAGE);
        payload["branch_id"] = chosen;
      } else {
        // Child records inherit their property from the parent booking.
        // Do not inject branch_id into tables without that column.
        delete payload["branch_id"];
      }
      const { data, error } = await db.from(table).insert(payload).select("id").maybeSingle();
      if (error) throw error;
      return data as Row;
    },
    onSuccess: (data, values) => {
      invalidate();
      toast.success(`${label} created`);
      void logAudit({
        organizationId,
        userId,
        userName,
        action: `events.${table}.create`,
        module: "events",
        recordId: (data?.["id"] as string) ?? null,
        newValue: values,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * A source-keyed idempotency key. Used only where a source record converts
 * exactly once (an enquiry, an accepted quotation), so a retry of the same
 * conversion always resolves to the same event.
 */
export function eventSourceKey(scope: string, sourceId: string): string {
  return `${scope}:${sourceId}`;
}

/** A fresh per-submission token for one form attempt. */
export function newEventAttemptKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `attempt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Holds one submission token for the lifetime of a single form attempt. Every
 * retry or double click of that attempt sends the same token, so the server
 * collapses them into one event. The token is rotated only after a confirmed
 * success or when the operator deliberately starts a new attempt â€” two
 * genuinely separate events with identical details are therefore never merged.
 */
export function useEventAttemptKey(): { key: string; reset: () => void } {
  const [key, setKey] = useState<string>(() => newEventAttemptKey());
  const reset = useCallback(() => setKey(newEventAttemptKey()), []);
  return { key, reset };
}

/** Authoritative event creation â€” the database allocates the reference. */
export function useCreateBooking() {
  const { organizationId, branchId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (values: Row) => {
      const chosen = (values["branch_id"] as string | undefined) ?? branchId;
      if (!chosen) throw new Error(PROPERTY_REQUIRED_MESSAGE);
      // A client can never choose the reference â€” the server allocates it.
      const { event_reference: _ignoredReference, ...rest } = values;
      const idempotencyKey = (values["idempotency_key"] as string | undefined) ?? newEventAttemptKey();
      const { data, error } = await guardedRpc(db, "neo_event_booking_create", {
        _payload: { ...rest, branch_id: chosen, idempotency_key: idempotencyKey },
      });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: (data, values) => {
      invalidate();
      toast.success(
        data?.["created"] === false
          ? "This event already exists â€” nothing was duplicated."
          : `Event ${String(data?.["event_reference"] ?? "")} created`,
      );
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.booking.create",
        module: "events",
        recordId: (data?.["booking_id"] as string) ?? null,
        newValue: values,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Move an event and all its dependent records to another property. */
export function useTransferBooking() {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ bookingId, branchId, reason }: { bookingId: string; branchId: string; reason: string }) => {
      const { data, error } = await guardedRpc(db, "neo_event_booking_transfer", {
        _booking: bookingId,
        _branch: branchId,
        _reason: reason,
      });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: (data, vars) => {
      invalidate();
      if (!data?.["moved"]) {
        toast.success("The event is already at that property");
      } else if (data?.["reference_reallocated"]) {
        toast.success(
          `Event transferred with all its records. Its reference was already in use at the destination, so ${String(
            data?.["old_reference"] ?? "",
          )} is now ${String(data?.["new_reference"] ?? "")}.`,
        );
      } else {
        toast.success(`Event transferred with all its records. Reference ${String(data?.["event_reference"] ?? "")} kept.`);
      }
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.booking.transfer",
        module: "events",
        recordId: vars.bookingId,
        newValue: data as Row,
        reason: vars.reason,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Enquiry â†’ event. Repeated calls return the same event. */
export function useConvertEnquiry() {
  const { organizationId, branchId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ enquiryId, values }: { enquiryId: string; values?: Row }) => {
      const { data, error } = await guardedRpc(db, "neo_event_convert_enquiry", {
        _enquiry: enquiryId,
        _payload: {
          ...(values ?? {}),
          ...(branchId ? { branch_id: branchId } : {}),
          idempotency_key: eventSourceKey("enquiry", enquiryId),
        },
      });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: (data, vars) => {
      invalidate();
      toast.success(data?.["created"] === false ? "This enquiry already has an event" : "Enquiry converted to an event");
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.enquiry.convert",
        module: "events",
        recordId: vars.enquiryId,
        newValue: data as Row,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Accepted quotation â†’ event. Repeated calls return the same event. */
export function useConvertQuotation() {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ quotationId, values }: { quotationId: string; values?: Row }) => {
      const { data, error } = await guardedRpc(db, "neo_event_convert_quotation", {
        _quotation: quotationId,
        _payload: {
          ...(values ?? {}),
          idempotency_key: eventSourceKey("quotation", quotationId),
        },
      });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: (data, vars) => {
      invalidate();
      toast.success(data?.["created"] === false ? "This quotation already has an event" : "Quotation converted to an event");
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.quotation.convert",
        module: "events",
        recordId: vars.quotationId,
        newValue: data as Row,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


export function useEventUpdate(table: string, label: string) {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, values }: { id: string; values: Row }) => {
      const { error } = await db.from(table).update(sanitizeEventValues(values)).eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: (id, vars) => {
      invalidate();
      toast.success(`${label} updated`);
      void logAudit({
        organizationId,
        userId,
        userName,
        action: `events.${table}.update`,
        module: "events",
        recordId: id,
        newValue: vars.values,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Retire or remove an events catalogue record (a venue, a package, a piece of
 * equipment, an event type).
 *
 * Retiring is the safe act and is always what a page should offer first: the
 * record stops being offered on new bookings while every event that already
 * used it keeps resolving. Deletion is only for a record that was never used;
 * when the database refuses because history points at it, the refusal is
 * reported as "still in use" rather than as a fault.
 */
export function useEventRetire(table: string, label: string, statusColumn = "active") {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      const { data, error } = await db
        .from(table)
        .update({ [statusColumn]: active })
        .eq("id", id)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error(
          `Nothing changed â€” your account is not allowed to ${active ? "reactivate" : "deactivate"} this ${label.toLowerCase()}.`,
        );
      }
      return { id, active };
    },
    onSuccess: ({ id, active }) => {
      invalidate();
      toast.success(`${label} ${active ? "reactivated" : "deactivated"}`);
      void logAudit({
        organizationId,
        userId,
        userName,
        action: `events.${table}.${active ? "reactivate" : "deactivate"}`,
        module: "events",
        recordId: id,
        newValue: { [statusColumn]: active },
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useEventDelete(table: string, label: string) {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (id: string) => {
      // Access rules make a refused delete silent: no error, no rows. The
      // returned rows are what confirm the record actually went.
      const { data, error } = await db.from(table).delete().eq("id", id).select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error(
          `Nothing was deleted â€” removing a ${label.toLowerCase()} is reserved for administrators. Deactivate it instead.`,
        );
      }
      return id;
    },
    onSuccess: (id) => {
      invalidate();
      toast.success(`${label} deleted`);
      void logAudit({
        organizationId,
        userId,
        userName,
        action: `events.${table}.delete`,
        module: "events",
        recordId: id,
      });
    },
    onError: (e: Error) => {
      const inUse = /foreign key|violates|referenced|23503/i.test(e.message);
      toast.error(
        inUse
          ? `This ${label.toLowerCase()} is already used by existing events, so it cannot be deleted. Deactivate it instead â€” past events keep their record.`
          : e.message,
      );
    },
  });
}

/** Reference numbers come from the shared numbering sequences. */
export async function nextNumber(docType: string, fallbackPrefix: string): Promise<string> {
  const { data, error } = await guardedRpc(db, "next_document_number", { _doc_type: docType });
  if (error || !data) return `${fallbackPrefix}-${Date.now().toString().slice(-6)}`;
  return String(data);
}

/** Idempotent booking confirmation â€” reserves venue, seeds milestones, tasks and BEO. */
export function useConfirmBooking() {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ bookingId, overrideReason }: { bookingId: string; overrideReason?: string }) => {
      const { data, error } = await guardedRpc(db, "events_confirm_booking", {
        _booking: bookingId,
        _override_reason: overrideReason ?? "",
      });
      if (error) throw error;
      return data as Row;
    },
    onSuccess: (data, vars) => {
      invalidate();
      if (data?.["already_confirmed"]) toast.info("This event was already confirmed â€” nothing was duplicated.");
      else toast.success(`Event confirmed Â· ${data?.["tasks_created"] ?? 0} department tasks generated`);
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.booking.confirm",
        module: "events",
        recordId: vars.bookingId,
        newValue: data as Row,
        reason: vars.overrideReason ?? null,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Never overwrite a sent or accepted quotation â€” supersede it with a new version. */
export function useReviseQuotation() {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (quotation: Row) => {
      const items = (quotation["event_quotation_items"] ?? []) as Row[];
      const {
        id: _id,
        created_at: _c,
        updated_at: _u,
        event_quotation_items: _i,
        customers: _cu,
        event_venues: _v,
        sent_at: _s,
        responded_at: _r,
        approved_by: _approvedBy,
        approved_at: _approvedAt,
        created_by: _createdBy,
        updated_by: _updatedBy,
        accepted_by_name: _acceptedBy,
        acceptance_note: _acceptanceNote,
        ...rest
      } = quotation;
      const { data, error } = await db
        .from("event_quotations")
        .insert({
          ...rest,
          organization_id: organizationId,
          version: Number(quotation["version"] ?? 1) + 1,
          supersedes_id: quotation["id"],
          status: "draft",
          approved_by: null,
          approved_at: null,
          sent_at: null,
          responded_at: null,
          accepted_by_name: "",
          acceptance_note: "",
          created_by: userId,
          updated_by: userId,
        })
        .select("id")
        .maybeSingle();
      if (error) throw error;
      const newId = data?.["id"] as string;
      if (items.length) {
        const { error: itemErr } = await db.from("event_quotation_items").insert(
          items.map((it) => ({
            organization_id: organizationId,
            quotation_id: newId,
            category: it["category"],
            description: it["description"],
            quantity: it["quantity"],
            unit: it["unit"],
            unit_price: it["unit_price"],
            line_total: it["line_total"],
            taxable: it["taxable"],
            unit_cost: it["unit_cost"],
            sort_order: it["sort_order"],
          })),
        );
        if (itemErr) throw itemErr;
      }
      return newId;
    },
    onSuccess: (id, quotation) => {
      invalidate();
      toast.success("New quotation version created â€” the previous version is preserved");
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.quotation.revise",
        module: "events",
        recordId: id,
        previousValue: { id: quotation["id"], version: quotation["version"] },
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Publish a BEO revision; material changes always create a new revision. */
export function useReviseBeo() {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({ beo, changeSummary }: { beo: Row; changeSummary: string }) => {
      const beoId = String(beo["id"] ?? "");
      if (!beoId) throw new Error("Choose a BEO to revise.");
      if (!changeSummary.trim()) throw new Error("Provide a summary of the revision.");

      const { data, error } = await guardedRpc(db, "neo_beo_revise", {
        _beo: beoId,
        _change_summary: changeSummary.trim(),
      });

      if (error) throw new Error(error.message);
      if (!data) throw new Error("The BEO revision was not created.");

      return String(data);
    },
    onSuccess: (id) => {
      invalidate();
      toast.success("BEO revision created");
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.beo.revise",
        module: "events",
        recordId: id,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Raise the banquet event order for a confirmed booking.
 *
 * The order is the operational handoff: until it exists, kitchen, housekeeping
 * and front office have nothing to work from. The database owns creation so the
 * numbering, the property and the permission check are the same wherever it is
 * raised from.
 */
export function useEnsureBeo() {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (bookingId: string) => {
      const { data, error } = await guardedRpc(db, "neo_event_beo_ensure", { _booking: bookingId });
      if (error) throw error;
      return String(data);
    },
    onSuccess: (id) => {
      invalidate();
      toast.success("Banquet event order raised");
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.beo.create",
        module: "events",
        recordId: id,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Publishing is the handoff itself: departments get their requirements, the
 * venue gets a preparation job, billing is built and everyone is notified.
 * Repeating it is safe â€” nothing is duplicated.
 */
export function usePublishBeo() {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (beoId: string) => {
      const { data, error } = await guardedRpc(db, "neo_event_beo_publish", { _beo: beoId });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (result) => {
      invalidate();
      const billingWarning = String(result["billing_warning"] ?? "").trim();

      if (billingWarning) {
        toast.warning(
          "BEO published, but the billing handoff needs attention.",
          { description: billingWarning },
        );
      } else {
        toast.success(
          "BEO published. Departmental handoffs completed.",
        );
      }
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.beo.publish",
        module: "events",
        recordId: String(result["beo_id"] ?? ""),
        newValue: result,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export type EventChainRow = {
  booking_id: string;
  event_reference: string;
  event_name: string | null;
  branch_id: string | null;
  event_date: string | null;
  status: string;
  beo_id: string | null;
  beo_number: string | null;
  beo_status: string | null;
  kitchen_handoff: boolean;
  housekeeping_handoff: boolean;
  front_office_handoff: boolean;
  housekeeping_job: boolean;
  billing_items: number;
  billed_amount: number;
  paid_amount: number;
  /** Negative once the date has passed. */
  days_to_event: number | null;
  is_past: boolean;
  /** Confirmed, close to the date (or past it), still without a published order. */
  beo_overdue: boolean;
  outstanding: number;
  missing: string[] | null;
};

/**
 * What happens when the date passes.
 *
 * A confirmed booking does not close itself: someone states the outcome â€”
 * it took place, the party did not arrive, or it was cancelled. Recording
 * that closes the department handoffs and freezes the operational side.
 * Any outstanding balance stays outstanding; closing an event never
 * settles or writes off money.
 */
export function useCloseOutEvent() {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async ({
      bookingId,
      outcome,
      reason,
    }: {
      bookingId: string;
      outcome: "completed" | "no-show" | "cancelled";
      reason?: string;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_event_close_out", {
        _booking: bookingId,
        _outcome: outcome,
        ...(reason ? { _reason: reason } : {}),
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (result, vars) => {
      invalidate();
      const outstanding = Number(result["outstanding"] ?? 0);
      toast.success(
        outstanding > 0
          ? `Event closed as ${vars.outcome}. An outstanding balance remains for Finance to collect.`
          : `Event closed as ${vars.outcome}.`,
      );
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.booking.close-out",
        module: "events",
        recordId: vars.bookingId,
        newValue: result,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Booking â†’ banquet order â†’ kitchen / housekeeping / billing â†’ payment. */
export function useEventChainStatus() {
  const { organizationId, branchId } = useEventsCtx();
  return useQuery({
    queryKey: ["events", "chain-status", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_event_chain_status", { _branch: branchId });
      if (error) throw error;
      return (data ?? []) as EventChainRow[];
    },
  });
}


/**
 * Conversion links.
 *
 * An enquiry or a quotation may produce exactly one event. This reader returns
 * the event already linked to each source record so the conversion screens can
 * show it instead of offering a second conversion that the database would
 * refuse anyway.
 */
export type ConversionLink = { bookingId: string; reference: string; status: string; eventDate: string | null };

export function useConversionLinks() {
  const { organizationId, branchId } = useEventsCtx();
  return useQuery({
    queryKey: ["events", "conversion-links", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q: Builder = db
        .from("event_bookings")
        .select("id, event_reference, status, event_date, enquiry_id, quotation_id");
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      const byEnquiry = new Map<string, ConversionLink>();
      const byQuotation = new Map<string, ConversionLink>();
      for (const row of (data ?? []) as Row[]) {
        const link: ConversionLink = {
          bookingId: String(row["id"]),
          reference: String(row["event_reference"] ?? ""),
          status: String(row["status"] ?? ""),
          eventDate: (row["event_date"] as string | null) ?? null,
        };
        if (row["enquiry_id"]) byEnquiry.set(String(row["enquiry_id"]), link);
        if (row["quotation_id"]) byQuotation.set(String(row["quotation_id"]), link);
      }
      return { byEnquiry, byQuotation };
    },
  });
}

/* ------------------------------------------------------------------ */
/* Authoritative event billing                                         */
/* ------------------------------------------------------------------ */

/**
 * A single event's bill, computed server-side from the event's own records.
 * The application never adds up money in the browser: `totals` is the only
 * balance Finance is allowed to read.
 */
export type EventBillLine = {
  id: string;
  category: string;
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  line_total: number | null;
  complimentary: boolean;
  generated: boolean;
};

export type EventBillPayment = {
  id: string;
  entry_type: string;
  method: string;
  amount: number;
  reference: string | null;
  reason: string | null;
  recorded_at: string;
  recorded_by: string | null;
  /** Receipt issued for money taken in; null for refunds, credits and adjustments. */
  receipt_number?: string | null;
  /** Till session the cash landed in, when it was cash. */
  shift_id?: string | null;
};

export type EventBillStatement = {
  ok: boolean;
  reason?: string;
  booking?: {
    id: string;
    reference: string;
    name: string | null;
    status: string;
    billing_status: string;
    event_date: string;
    branch_id: string | null;
    billed_at: string | null;
    generated_at: string | null;
    deposit_required: number;
    currency: string;
  };
  totals?: { charged: number; complimentary: number; paid: number; outstanding: number };
  lines?: EventBillLine[];
  payments?: EventBillPayment[];
};

export function useEventBillStatement(bookingId: string | null) {
  const { organizationId } = useEventsCtx();
  return useQuery({
    queryKey: ["events", "bill-statement", organizationId, bookingId],
    enabled: Boolean(organizationId && bookingId),
    queryFn: async () => {
      const { data, error } = await guardedRpc(db, "neo_event_billing_statement", { _booking: bookingId });
      if (error) throw error;
      return (data ?? { ok: false }) as EventBillStatement;
    },
  });
}

/**
 * Invoices already issued against events. Read-only lookup so the billing
 * screens can print the canonical Finance document instead of issuing a second
 * one. Scoped to the selected property; Finance RLS still decides visibility.
 */
export type EventInvoiceRef = {
  id: string;
  invoice_number: string | null;
  status: string | null;
  event_booking_id: string;
};

export function useEventInvoices() {
  const { organizationId, branchId } = useEventsCtx();
  return useQuery({
    queryKey: ["events", "invoices", organizationId, branchId],
    enabled: Boolean(organizationId),
    retry: false,
    queryFn: async () => {
      let q = db
        .from("invoices")
        .select("id, invoice_number, status, event_booking_id")
        .not("event_booking_id", "is", null);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      const map: Record<string, EventInvoiceRef> = {};
      for (const row of (data ?? []) as EventInvoiceRef[]) {
        if (row.event_booking_id) map[row.event_booking_id] = row;
      }
      return map;
    },
  });
}

export function useEventInvoice(bookingId: string | null) {
  const { organizationId } = useEventsCtx();
  return useQuery({
    queryKey: ["events", "invoice", organizationId, bookingId],
    enabled: Boolean(organizationId && bookingId),
    retry: false,
    queryFn: async () => {
      const { data, error } = await db
        .from("invoices")
        .select("id, invoice_number, status, event_booking_id")
        .eq("event_booking_id", bookingId)
        .order("issue_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as EventInvoiceRef | null;
    },
  });
}



function useBillingMutation<TVars>(
  fn: (vars: TVars) => Promise<Record<string, unknown>>,
  action: string,
  successMessage: (result: Record<string, unknown>) => string,
) {
  const qc = useQueryClient();
  const { organizationId } = useEventsCtx();
  return useMutation({
    mutationFn: async (vars: TVars) => {
      const result = await fn(vars);
      if (result["ok"] !== true) {
        const detail = (result["detail"] as string | undefined) ?? BILLING_REASONS[String(result["reason"])] ??
          "The bill could not be updated.";
        throw new Error(detail);
      }
      await logAudit({
        action,
        module: "events",
        recordId: String((vars as Record<string, unknown>)["bookingId"] ?? ""),
        newValue: result,
      });
      return result;
    },
    onSuccess: (result) => {
      toast.success(successMessage(result));
      void qc.invalidateQueries({ queryKey: ["events"] });
      void qc.invalidateQueries({ queryKey: ["finance"] });
      void organizationId;
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

const BILLING_REASONS: Record<string, string> = {
  not_found: "That event no longer exists.",
  no_organisation: "Your workspace is not ready yet.",
  already_finalised: "The bill is finalised. Reopen it before rebuilding.",
  not_billed: "Build the bill before recording money against this event.",
  no_lines: "Build the bill before finalising it.",
  reason_required: "A written reason is required.",
  invalid_entry_type: "That entry type is not supported.",
  zero_amount: "Enter an amount other than zero.",
  already_posted: "This event is already recognised in Finance.",
};

export function useBuildEventBill() {
  return useBillingMutation<{ bookingId: string }>(
    async ({ bookingId }) => {
      const { data, error } = await guardedRpc(db, "neo_event_billing_build", { _booking: bookingId });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    "events.billing.build",
    (r) => `Bill rebuilt â€” ${r["lines"]} line(s).`,
  );
}

export function useRecordEventPayment() {
  return useBillingMutation<{
    bookingId: string;
    amount: number;
    entryType: string;
    method: string;
    reference?: string | undefined;
    intentKey?: string | undefined;
    reason?: string | undefined;
    /** Which of the hotel's accounts received the money. */
    destinationAccountId?: string | null | undefined;
  }>(
    async (v) => {
      const { data, error } = await guardedRpc(db, "neo_event_billing_record_payment", {
        _booking: v.bookingId,
        _amount: v.amount,
        _entry_type: v.entryType,
        _method: v.method,
        _reference: v.reference ?? null,
        _intent_key: v.intentKey ?? null,
        _reason: v.reason ?? null,
        _account: v.destinationAccountId ?? null,
      } as never);
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    "events.billing.payment",
    () => "Entry recorded against the event bill.",
  );
}

export function useFinaliseEventBill() {
  return useBillingMutation<{ bookingId: string; reason?: string | undefined }>(
    async (v) => {
      const { data, error } = await guardedRpc(db, "neo_event_billing_finalise", {
        _booking: v.bookingId,
        _reason: v.reason ?? null,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    "events.billing.finalise",
    () => "Bill finalised â€” the event is now eligible for Finance.",
  );
}

export function useReopenEventBill() {
  return useBillingMutation<{ bookingId: string; reason: string }>(
    async (v) => {
      const { data, error } = await guardedRpc(db, "neo_event_billing_reopen", {
        _booking: v.bookingId,
        _reason: v.reason,
      });
      if (error) throw error;
      return (data ?? {}) as Record<string, unknown>;
    },
    "events.billing.reopen",
    () => "Bill reopened for correction.",
  );
}

/**
 * Set the working times on a banquet order: room set-up, guest arrival,
 * service start and finish, and clear-down. The database keeps the order
 * sensible (set-up before arrival, finish after start) and records who
 * changed it.
 */
export function useSetBeoTimings() {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async (input: {
      beoId: string;
      setupAt?: string | null;
      guestArrivalAt?: string | null;
      startAt?: string | null;
      endAt?: string | null;
      breakdownAt?: string | null;
      servingTimes?: string | null;
      seatingLayout?: string | null;
      reason?: string | null;
    }) => {
      const { data, error } = await guardedRpc(db, "neo_beo_set_timings", {
        _beo: input.beoId,
        _setup_at: input.setupAt ?? null,
        _guest_arrival_at: input.guestArrivalAt ?? null,
        _start_at: input.startAt ?? null,
        _end_at: input.endAt ?? null,
        _breakdown_at: input.breakdownAt ?? null,
        _serving_times: input.servingTimes ?? null,
        _seating_layout: input.seatingLayout ?? null,
        _reason: input.reason ?? null,
      });
      if (error) throw error;
      const result = (data ?? {}) as Record<string, unknown>;
      if (result["ok"] !== true) {
        throw new Error((result["detail"] as string) ?? "Those times could not be saved.");
      }
      return result;
    },
    onSuccess: (result) => {
      invalidate();
      toast.success("Banquet times saved");
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.beo.timings",
        module: "events",
        recordId: String(result["beo_id"] ?? ""),
        newValue: result,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* --------------------- banquet service & reconciliation --------------------- */

/**
 * Every live banquet order at the selected property, with its planned working
 * times and the real moments the floor actually stamped. Planned and actual are
 * kept apart on purpose: a plan that was never met is a fact worth seeing.
 */
export function useBanquetService() {
  const { organizationId, branchId } = useEventsCtx();
  return useQuery({
    queryKey: ["events", "banquet-service", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q: Builder = db
        .from("banquet_event_orders")
        .select(
          sel(
            "id, beo_number, revision, status, setup_at, guest_arrival_at, start_at, end_at, breakdown_at, serving_times, seating_layout, guaranteed_guests, final_guests, setup_done_at, service_started_at, service_ended_at, cleanup_done_at, booking_id, event_bookings(event_reference, event_name, event_date, status, expected_guests, event_venues(name))",
          ),
        )
        .eq("status", "published")
        .order("start_at", { ascending: false })
        .limit(200);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}

/** Stamp a real moment on a banquet order: set-up done, service start/end, cleared. */
export function useStampBanquetMoment() {
  const { organizationId, userId, userName } = useEventsCtx();
  const invalidate = useInvalidate();
  const reasons: Record<string, string> = {
    not_found: "That banquet order no longer exists.",
    forbidden: "That banquet order belongs to another workspace.",
    not_permitted: "You do not have permission to update banquet orders.",
    invalid_moment: "That is not a moment this screen can record.",
    service_not_started: "Record the service start before the finish.",
    ends_before_start: "Service cannot finish before it started.",
    service_not_ended: "Record the service finish before clearing down.",
    cleanup_before_service_end: "Clear-down cannot be before service finished.",
  };
  return useMutation({
    mutationFn: async ({ beoId, moment }: { beoId: string; moment: string }) => {
      const { data, error } = await guardedRpc(db, "neo_beo_stamp", { _beo: beoId, _moment: moment });
      if (error) throw error;
      const result = (data ?? {}) as Record<string, unknown>;
      if (result["ok"] !== true) {
        throw new Error(reasons[String(result["reason"])] ?? "That moment could not be recorded.");
      }
      return result;
    },
    onSuccess: (result) => {
      invalidate();
      toast.success("Recorded");
      void logAudit({
        organizationId,
        userId,
        userName,
        action: "events.beo.stamp",
        module: "events",
        recordId: String(result["beo_id"] ?? ""),
        newValue: result,
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export type EventPaymentRow = Row;

/**
 * Money actually received against events at the selected property, as recorded
 * â€” never inferred. Used to reconcile what was billed against what came in by
 * cash, M-Pesa, card or transfer.
 */
export function useEventPaymentLedger() {
  const { organizationId, branchId } = useEventsCtx();
  return useQuery({
    queryKey: ["events", "payment-ledger", organizationId, branchId],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q: Builder = db
        .from("event_payments")
        .select(
          sel(
            "id, booking_id, entry_type, method, amount, currency, reference, reason, recorded_at, event_bookings(event_reference, event_name, event_date, total_amount, paid_amount, deposit_required, deposit_paid, payment_status, status)",
          ),
        )
        .order("recorded_at", { ascending: false })
        .limit(500);
      if (branchId) q = q.eq("branch_id", branchId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
}
