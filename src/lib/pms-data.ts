import { guardedRpc } from "@/lib/rpc-guard";
import { ilikeOrFilter } from "@/lib/or-filter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActivePropertyFilter, useWriteBranchId } from "@/lib/branch-filter";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { DEFAULT_PMS_SETTINGS, type PmsSettings, today } from "@/lib/pms";

/* ------------------------------------------------------------------ *
 * Reference data
 * ------------------------------------------------------------------ */

export function useRoomTypes() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "room-types", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("room_types").select("*"), "room_types")
        .order("sort_order")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useRooms() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "rooms", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("rooms").select("*, room_types(name, code, max_occupancy)"), "rooms")
        .order("room_number");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useMealPlans() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "meal-plans", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("meal_plans").select("*"), "meal_plans").order("code");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useRatePlans() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "rate-plans", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("rate_plans").select("*, room_types(name), meal_plans(code, name)"), "rate_plans")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCustomers(search: string) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "customers", organizationId, search],
    enabled: Boolean(organizationId) && search.trim().length >= 2,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customers")
        .select("id, customer_number, full_name, email, phone, customer_type, is_vip")
        .or(ilikeOrFilter(["full_name", "email", "phone", "customer_number"], search))
        .limit(12);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Reservations & stays
 * ------------------------------------------------------------------ */

export const RESERVATION_SELECT =
  "*, customers(id, full_name, email, phone, is_vip), room_types(name, code), rooms(room_number), rate_plans(name), meal_plans(code), corporate_accounts(legal_name, trading_name), group_bookings(name, reference)";

export function useReservations(filters: {
  status?: string;
  from?: string;
  to?: string;
  search?: string;
  scope?: "arrivals" | "departures" | "in-house" | "all";
  date?: string;
}) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "reservations", organizationId, filters, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(supabase.from("reservations").select(RESERVATION_SELECT), "reservations");
      const on = filters.date ?? today();
      if (filters.scope === "arrivals") q = q.eq("arrival_date", on).in("status", ["confirmed", "guaranteed", "tentative", "pending-deposit"]);
      if (filters.scope === "departures") q = q.eq("departure_date", on).eq("status", "checked-in");
      if (filters.scope === "in-house") q = q.eq("status", "checked-in");
      if (filters.status && filters.status !== "all") q = q.eq("status", filters.status);
      if (filters.from) q = q.gte("arrival_date", filters.from);
      if (filters.to) q = q.lte("arrival_date", filters.to);
      if (filters.search && filters.search.trim().length >= 2) {
        q = q.or(
          ilikeOrFilter(["confirmation_number", "external_reference", "special_requests"], filters.search),
        );
      }
      const { data, error } = await q.order("arrival_date", { ascending: true }).limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useReservation(id: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "reservation", organizationId, id, filterKey],
    enabled: Boolean(organizationId) && Boolean(id),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("reservations").select(RESERVATION_SELECT), "reservations").eq("id", id).maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useReservationFolios(reservationId: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pms", "folios", "reservation", reservationId, filterKey],
    enabled: Boolean(reservationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("folios").select("*, folio_lines(*), payments(*)"), "folios")
        .eq("reservation_id", reservationId)
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useReservationHistory(reservationId: string) {
  return useQuery({
    queryKey: ["pms", "reservation-history", reservationId],
    enabled: Boolean(reservationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("reservation_history")
        .select("*")
        .eq("reservation_id", reservationId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAvailability(params: {
  branch: string | null;
  arrival: string;
  departure: string;
  roomType: string | null;
  adults: number;
  children: number;
  forGroup?: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["pms", "availability", params],
    enabled: params.enabled !== false && Boolean(params.arrival && params.departure),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "pms_available_rooms", {
        _branch: params.branch,
        _arrival: params.arrival,
        _departure: params.departure,
        _room_type: params.roomType,
        _adults: params.adults,
        _children: params.children,
        _for_group: params.forGroup ?? null,
      } as never);
      if (error) throw error;
      return (data ?? []) as AvailableRoom[];
    },
  });
}

export type AvailableRoom = {
  room_id: string;
  room_number: string;
  room_type_id: string;
  room_type_name: string;
  floor: string | null;
  branch_id: string | null;
  branch_name: string | null;
  max_occupancy: number | null;
  readiness: string | null;
  maintenance_status: string | null;
  occupancy_status: string | null;
  nights: number | null;
  qualification: string | null;
};


export function useFrontOfficeMetrics(branch: string | null, on: string) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "metrics", organizationId, branch, on],
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "pms_front_office_metrics", { _branch: branch, _on: on } as never);
      if (error) throw error;
      return data as unknown as FrontOfficeMetrics;
    },
  });
}

export type FrontOfficeMetrics = {
  date: string;
  rooms: {
    total: number;
    sellable: number;
    vacant_clean: number;
    vacant_dirty: number;
    occupied: number;
    out_of_order: number;
    maintenance: number;
  };
  reservations: {
    arrivals_today: number;
    departures_today: number;
    in_house: number;
    unassigned: number;
    vip_arrivals: number;
    corporate_arrivals: number;
    group_arrivals: number;
    no_shows: number;
    cancelled: number;
  };
  folios: { open: number; attention: number; outstanding_balance: number };
  requests: { open: number; overdue: number };
  waitlist: number;
};

/* ------------------------------------------------------------------ *
 * Operational mutations — every one is a database function so the rules,
 * idempotency and audit trail live next to the data.
 * ------------------------------------------------------------------ */

function useInvalidatePms() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["pms"] });
  };
}

export function useCheckIn() {
  const invalidate = useInvalidatePms();
  return useMutation({
    mutationFn: async (input: { reservation: string; keys: number; notes: string }) => {
      const { data, error } = await guardedRpc(supabase, "pms_check_in", {
        _reservation: input.reservation,
        _keys: input.keys,
        _notes: input.notes,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Guest checked in — folio opened and housekeeping notified");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Undo an accidental check-in. The database restores the reservation, room and
 * folio to their pre-arrival state, and refuses when the folio already carries
 * posted activity.
 */
export function useRevertCheckIn() {
  const invalidate = useInvalidatePms();
  return useMutation({
    mutationFn: async (input: { reservation: string; reason: string }) => {
      const { data, error } = await guardedRpc(supabase, "pms_revert_check_in", {
        _reservation: input.reservation,
        _reason: input.reason,
      });
      if (error) throw error;
      const result = (data ?? {}) as Record<string, unknown>;
      if (result["ok"] !== true) {
        throw new Error(
          (result["detail"] as string | undefined) ?? "The check-in could not be reverted.",
        );
      }
      await logAudit({
        action: "pms.checkin.revert",
        module: "front-office",
        recordId: input.reservation,
        reason: input.reason,
        newValue: result,
      });
      return result;
    },
    onSuccess: () => {
      toast.success("Check-in reverted — the reservation is confirmed again");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Drift between check-in and the counts, folios and history it should update. */
export type CheckInReconciliationRow = {
  issue: string;
  severity: string;
  reservation_id: string | null;
  reference: string | null;
  room_number: string | null;
  detail: string;
  required_action: string;
  drill_to: string;
};

export function useCheckInReconciliation(branch: string | null) {
  return useQuery({
    queryKey: ["pms", "checkin-reconciliation", branch],
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, 
        "neo_checkin_reconciliation",
        branch ? { _branch: branch } : {},
      );
      if (error) throw error;
      return (data ?? []) as unknown as CheckInReconciliationRow[];
    },
    refetchInterval: 60_000,
  });
}

export function useCheckOut() {
  const invalidate = useInvalidatePms();
  return useMutation({
    mutationFn: async (input: { reservation: string; force: boolean; notes: string }) => {
      const { data, error } = await guardedRpc(supabase, "pms_check_out", {
        _reservation: input.reservation,
        _force: input.force,
        _notes: input.notes,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Guest checked out — room released for cleaning");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAssignRoom() {
  const invalidate = useInvalidatePms();
  return useMutation({
    mutationFn: async (input: { reservation: string; room: string; reason: string }) => {
      const { data, error } = await guardedRpc(supabase, "pms_assign_room", {
        _reservation: input.reservation,
        _room: input.room,
        _reason: input.reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Room assigned");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useTransferRoom() {
  const invalidate = useInvalidatePms();
  return useMutation({
    mutationFn: async (input: { reservation: string; toRoom: string; reason: string; moveType: string }) => {
      const { data, error } = await guardedRpc(supabase, "pms_transfer_room", {
        _reservation: input.reservation,
        _to_room: input.toRoom,
        _reason: input.reason,
        _move_type: input.moveType,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Room move recorded — folio continuity preserved");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function usePostCharge() {
  const invalidate = useInvalidatePms();
  return useMutation({
    mutationFn: async (input: {
      folio: string;
      category: string;
      description: string;
      quantity: number;
      unitPrice: number;
      tax: number;
    }) => {
      const { data, error } = await guardedRpc(supabase, "pms_post_room_charge", {
        _folio: input.folio,
        _category: input.category,
        _description: input.description,
        _quantity: input.quantity,
        _unit_price: input.unitPrice,
        _tax: input.tax,
        _source_module: "pms",
        _source_record_id: "",
        _idempotency_key: crypto.randomUUID(),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Charge posted to folio");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * The hotel's own receiving accounts. Front desk reads the same shared list as
 * every other collection point, so "money received into" means one thing.
 */
export { useReceivingAccounts } from "@/lib/financial-accounts";

export function useRecordPayment() {
  const invalidate = useInvalidatePms();
  return useMutation({
    // `intentKey` is the canonical collection intent: one key per act of
    // collection, so a double-click or a retry returns the receipt that
    // already exists instead of taking the guest's money twice.
    mutationFn: async (input: {
      folio: string;
      amount: number;
      method: string;
      reference: string;
      notes: string;
      intentKey?: string | null;
      // Which of the hotel's own accounts the money landed in. Left unset,
      // the ledger falls back to the default account for the method.
      account?: string | null;
    }) => {
      const { data, error } = await guardedRpc(supabase, "pms_record_payment", {
        _folio: input.folio,
        _amount: input.amount,
        _method: input.method,
        _reference: input.reference,
        _notes: input.notes,
        _intent_key: input.intentKey ?? null,
        _account: input.account ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Payment recorded");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/**
 * Close a settled folio. The database refuses a folio that still carries a
 * balance, so closing can never be used to make an unpaid bill disappear.
 */
export function useCloseFolio() {
  const invalidate = useInvalidatePms();
  return useMutation({
    mutationFn: async (input: { folio: string; reason?: string }) => {
      const { data, error } = await guardedRpc(supabase, "folio_close", {
        _folio: input.folio,
        _reason: input.reason ?? null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Folio closed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


export function usePostAccommodation() {
  const invalidate = useInvalidatePms();
  return useMutation({
    mutationFn: async (operationalDate: string) => {
      const { data, error } = await guardedRpc(supabase, "pms_post_accommodation", { _operational_date: operationalDate });
      if (error) throw error;
      return data as number;
    },
    onSuccess: (count) => {
      toast.success(count === 0 ? "Nothing to post — every in-house folio is already up to date" : `Posted ${count} accommodation charge(s)`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export function usePmsSettings() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "settings", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("pms_settings").select("*"), "pms_settings").limit(1).maybeSingle();
      if (error) throw error;
      return {
        id: data?.id ?? null,
        settings: { ...DEFAULT_PMS_SETTINGS, ...((data?.settings as Partial<PmsSettings>) ?? {}) },
      };
    },
  });
}

export function useSavePmsSettings() {
  const { organizationId, user } = useAuth();
  const writeBranchId = useWriteBranchId();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string | null; settings: PmsSettings }) => {
      if (!organizationId) throw new Error("No organisation context");
      if (input.id) {
        const { error } = await supabase
          .from("pms_settings")
          .update({ settings: input.settings as never })
          .eq("id", input.id);
        if (error) throw error;
        return;
      }
      const { error } = await supabase.from("pms_settings").insert({
        organization_id: organizationId,
        branch_id: writeBranchId,
        settings: input.settings as never,
        created_by: user?.id ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("PMS settings saved");
      void qc.invalidateQueries({ queryKey: ["pms", "settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Phase 5 — folios directory, groups, waitlist and guest requests
 * ------------------------------------------------------------------ */

export function useFolioDirectory(status: string) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "folio-directory", organizationId, status],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = supabase
        .from("folios")
        .select(
          "*, customers(full_name), reservations(confirmation_number), corporate_accounts(legal_name), group_bookings(name)",
        )
        .order("opened_at", { ascending: false })
        .limit(200);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

/**
 * Guests who have departed while their folio is still open.
 *
 * A departure is only finished when the bill is settled and the folio closed.
 * Anything left in this list is money the property has not collected and a bill
 * Finance cannot see as complete, so it is surfaced as a working queue rather
 * than left to a month-end discovery.
 */
export function useDeparturesPendingSettlement() {
  const { organizationId } = useAuth();
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pms", "departures-pending-settlement", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase
          .from("folios")
          .select(
            "id, folio_number, status, total_charges, total_payments, balance, branch_id, customers(full_name), reservations!inner(confirmation_number, status)",
          ),
        "folios",
      )
        .eq("reservations.status", "checked-out")
        .neq("status", "closed")
        .order("balance", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as Array<{
        id: string;
        folio_number: string;
        status: string;
        total_charges: number;
        total_payments: number;
        balance: number;
        customers: { full_name: string | null } | null;
        reservations: { confirmation_number: string | null } | null;
      }>;
    },
  });
}


export function useGroupBookings() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "group-bookings", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("group_bookings").select("*, corporate_accounts(legal_name), rate_plans(name), meal_plans(code)"), "group_bookings")
        .order("arrival_date", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useWaitlist(status: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "waitlist", organizationId, status, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(supabase.from("waitlist_entries").select("*, customers(full_name, phone, email), room_types(name)"), "waitlist_entries")
        .order("arrival_date")
        .limit(200);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useGuestRequests(status: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "guest-requests", organizationId, status, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(supabase.from("guest_requests").select("*, customers(full_name), rooms(room_number), departments(name)"), "guest_requests")
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(200);
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useUpdateGuestRequestStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; status: string }) => {
      const { error } = await supabase
        .from("guest_requests")
        .update({
          status: input.status,
          completed_at: input.status === "completed" ? new Date().toISOString() : null,
        })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Request updated");
      void qc.invalidateQueries({ queryKey: ["pms", "guest-requests"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
