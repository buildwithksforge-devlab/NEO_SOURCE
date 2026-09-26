/**
 * NEØ Guest experience data layer.
 *
 * Every read here is owner-scoped by row-level policies and every write goes
 * through a database routine that resolves the customer from the signed-in
 * account — the browser never states which customer it is.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { guardPreview, previewSuppressed } from "@/lib/preview-mode";

type Row = Record<string, unknown>;
const rpc = supabase as unknown as {
  rpc: (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
  from: (table: string) => any;
};

export const requestCategories = [
  { value: "housekeeping", label: "Housekeeping" },
  { value: "amenities", label: "Towels & amenities" },
  { value: "maintenance", label: "Maintenance issue" },
  { value: "laundry", label: "Laundry" },
  { value: "concierge", label: "Concierge / general" },
  { value: "front-office", label: "Front office (late checkout, extend stay)" },
  { value: "transport", label: "Transport / transfer" },
] as const;

export const requestStatusLabels: Record<string, string> = {
  new: "Requested",
  acknowledged: "Accepted",
  assigned: "Accepted",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  declined: "Declined",
};

/**
 * The signed-in person's customer record for this property.
 *
 * A guest invited by staff claims the existing CRM record; a guest who signed
 * up on their own (or confirmed their email and came back later) is given a
 * guest record here, so the account, booking, order and folio screens all work
 * from the same single customer — never a duplicate.
 */
export function useGuestProfile(
  organizationId: string,
  userId?: string | null,
  branchId?: string | null,
) {
  const client = useQueryClient();

  const query = useQuery({
    queryKey: ["guest-profile", organizationId, userId ?? "none"],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await rpc
        .from("customers")
        .select(
          "id, organization_id, primary_branch_id, full_name, preferred_name, avatar_url, phone, email, customer_number, preferred_language, marketing_consent, guest_account_status, guest_linked_at, last_guest_app_activity_at",
        )
        .eq("organization_id", organizationId)
        .eq("auth_user_id", userId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as Row | null;
    },
  });

  const linked = Boolean(query.data);
  useEffect(() => {
    if (!userId || query.isLoading || linked || previewSuppressed()) return;
    let cancelled = false;
    void (async () => {
      let claimed = false;
      try {
        const { data } = await guardedRpc(rpc, "neo_guest_claim_invitation", { _org: organizationId });
        claimed = (data as { linked?: boolean } | null)?.linked === true;
      } catch {
        claimed = false;
      }
      if (!claimed) {
        // No staff invitation: create this person's own guest record.
        try {
          await guardedRpc(rpc, "customer_register_self", {
            _org: organizationId,
            _branch: branchId ?? null,
            _full_name: "",
            _phone: "",
          });
        } catch {
          /* the screen shows the unlinked state instead */
        }
      }
      if (!cancelled) {
        void client.invalidateQueries({ queryKey: ["guest-profile", organizationId] });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [organizationId, branchId, userId, query.isLoading, linked, client]);

  return query;
}


/** Records a factual guest-app activity event, at most once per key. */
export async function recordGuestEvent(input: {
  organizationId: string;
  eventType: string;
  subjectType?: string;
  subjectId?: string;
  properties?: Record<string, unknown>;
  idempotencyKey?: string;
}) {
  // A staff walkthrough must leave no trace at all: telemetry no-ops in
  // preview rather than relying on disabled controls.
  if (previewSuppressed()) return null;
  // Anonymous browsing has no guest to attribute the event to; calling the
  // routine signed-out only produced a 401 in the browser console.
  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData.session) return null;
  const { error } = await guardedRpc(rpc, "neo_guest_record_event", {

    _org: input.organizationId,
    _event_type: input.eventType,
    _subject_type: input.subjectType ?? null,
    _subject_id: input.subjectId ?? null,
    _properties: input.properties ?? {},
    _idempotency_key: input.idempotencyKey ?? null,
    _surface: "guest_app",
  });
  if (error) return null;
  return true;
}

/** Fire-and-forget screen view, deduplicated per session. */
export function useGuestScreenView(organizationId: string, screen: string, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const key = `${screen}:${new Date().toISOString().slice(0, 13)}`;
    void recordGuestEvent({
      organizationId,
      eventType: "screen.viewed",
      subjectType: "screen",
      subjectId: screen,
      idempotencyKey: `view:${key}`,
    });
  }, [organizationId, screen, enabled]);
}

export function useUpdateGuestProfile(organizationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      fullName?: string;
      preferredName?: string;
      phone?: string;
      avatarUrl?: string | null;
      preferredLanguage?: string;
      marketingConsent?: boolean;
    }) => {
      guardPreview();
      const { error } = await guardedRpc(rpc, "neo_guest_update_profile", {
        _org: organizationId,
        _full_name: input.fullName ?? null,
        _preferred_name: input.preferredName ?? null,
        _phone: input.phone ?? null,
        _avatar_url: input.avatarUrl === undefined ? null : input.avatarUrl,
        _preferred_language: input.preferredLanguage ?? null,
        _marketing_consent: input.marketingConsent ?? null,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["guest-profile", organizationId] }),
  });
}

export function useGuestRequests(organizationId: string, customerId?: string | null) {
  return useQuery({
    queryKey: ["guest-requests", organizationId, customerId ?? "none"],
    enabled: Boolean(customerId),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await rpc
        .from("guest_requests")
        .select("id, category, description, status, priority, created_at, completed_at, resolution_notes")
        .eq("organization_id", organizationId)
        .eq("customer_id", customerId)
        .order("created_at", { ascending: false })
        .limit(40);
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export function useCreateGuestRequest(organizationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { category: string; description: string; priority?: string }) => {
      guardPreview();
      const { data, error } = await guardedRpc(rpc, "neo_guest_create_request", {
        _org: organizationId,
        _category: input.category,
        _description: input.description,
        _priority: input.priority ?? "normal",
      });
      if (error) throw new Error(error.message);
      return data as string;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["guest-requests", organizationId] }),
  });
}

export function useGuestReservations(organizationId: string, customerId?: string | null) {
  return useQuery({
    queryKey: ["guest-reservations", organizationId, customerId ?? "none"],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await rpc
        .from("reservations")
        .select(
          "id, confirmation_number, status, arrival_date, departure_date, nights, adults, children, total_amount, balance",
        )
        .eq("organization_id", organizationId)
        .eq("customer_id", customerId)
        .order("arrival_date", { ascending: false })
        .limit(25);
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export function useGuestAddresses(organizationId: string, customerId?: string | null) {
  return useQuery({
    queryKey: ["guest-addresses", organizationId, customerId ?? "none"],
    enabled: Boolean(customerId),
    queryFn: async () => {
      const { data, error } = await rpc
        .from("customer_addresses")
        .select("id, label, address_line, city, is_primary, delivery_instructions")
        .eq("organization_id", organizationId)
        .eq("customer_id", customerId)
        .order("is_primary", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export const IN_HOUSE_STATUSES = ["checked_in", "in_house"];

export function isInHouse(reservation: Row | undefined) {
  return Boolean(reservation && IN_HOUSE_STATUSES.includes(String(reservation["status"])));
}

/**
 * My Stay.
 *
 * A customer sees a booking either because it was made under their own
 * customer record, or because they proved it is theirs with the confirmation
 * reference plus a detail already held on the booking. The database decides;
 * no reference or record number typed into the address bar can widen this.
 */
export function useMyStays(organizationId: string, enabled = true) {
  return useQuery({
    queryKey: ["guest-my-stays", organizationId],
    enabled,
    queryFn: async () => {
      const { data, error } = await guardedRpc(rpc, "neo_guest_my_stays", { _org: organizationId });
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });
}

export type StayVerificationResult =
  | { verified: true; reservation_id: string; confirmation_number: string }
  | { verified: false; reason: string };

export const stayVerificationMessages: Record<string, string> = {
  not_signed_in: "Please sign in first.",
  incomplete: "Enter your booking reference and the surname, phone or email on the booking.",
  no_customer_record: "We could not find your customer profile for this hotel yet.",
  no_match: "Those details do not match a booking at this hotel.",
  too_many_attempts: "Too many attempts. Please try again later.",
};

export function useVerifyStay(organizationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { reference: string; detail: string }) => {
      guardPreview();
      const { data, error } = await guardedRpc(rpc, "neo_guest_verify_stay", {
        _org: organizationId,
        _reference: input.reference,
        _detail: input.detail,
      });
      if (error) throw new Error(error.message);
      return data as unknown as StayVerificationResult;
    },
    onSuccess: (result) => {
      if (result.verified) {
        void client.invalidateQueries({ queryKey: ["guest-my-stays", organizationId] });
      }
    },
  });
}
