import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useActivePropertyFilter, useWriteBranchId } from "@/lib/branch-filter";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useScopedDepartments, useScopedWorkerOptions } from "@/lib/scoped-options";

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function useInvalidate(keys: string[]) {
  const qc = useQueryClient();
  return () => keys.forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
}

// The generated RPC union is large enough to blow the type instantiation
// budget, so bind through an untyped handle and narrow at each call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpcClient = supabase as any;
const rpc = rpcClient.rpc.bind(rpcClient) as (
  fn: string,
  args?: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function callRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/* ------------------------------------------------------------------ *
 * Groups, blocks and rooming lists
 * ------------------------------------------------------------------ */

export function useGroupBooking(id: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pms", "group", id, filterKey],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("group_bookings").select("*, corporate_accounts(legal_name), rate_plans(name), meal_plans(code, name), customers(full_name, email, phone)"), "group_bookings")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useGroupBlocks(groupId: string) {
  return useQuery({
    queryKey: ["pms", "group-blocks", groupId],
    enabled: Boolean(groupId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("group_room_blocks")
        .select("*, room_types(name, code), rate_plans(name), meal_plans(code)")
        .eq("group_booking_id", groupId)
        .order("start_date");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useRoomingList(groupId: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pms", "rooming-list", groupId, filterKey],
    enabled: Boolean(groupId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("group_rooming_list").select("*"), "group_rooming_list")
        .eq("group_booking_id", groupId)
        .order("guest_name");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useGroupEvents(groupId: string) {
  return useQuery({
    queryKey: ["pms", "group-events", groupId],
    enabled: Boolean(groupId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("group_block_events")
        .select("*")
        .eq("group_booking_id", groupId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useSaveGroupBlock() {
  const { organizationId } = useAuth();
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: async (input: {
      id?: string;
      groupId: string;
      roomTypeId: string;
      roomsBlocked: number;
      complimentaryRooms: number;
      rateAmount: number;
      startDate: string;
      endDate: string;
      cutoffDate: string | null;
      ratePlanId: string | null;
      mealPlanId: string | null;
    }) => {
      const payload = {
        organization_id: organizationId,
        group_booking_id: input.groupId,
        room_type_id: input.roomTypeId,
        rooms_blocked: input.roomsBlocked,
        complimentary_rooms: input.complimentaryRooms,
        rate_amount: input.rateAmount,
        start_date: input.startDate,
        end_date: input.endDate,
        cutoff_date: input.cutoffDate,
        rate_plan_id: input.ratePlanId,
        meal_plan_id: input.mealPlanId,
      };
      if (input.id) {
        const { error } = await supabase.from("group_room_blocks").update(payload as never).eq("id", input.id);
        if (error) throw error;
        return;
      }
      const { error } = await supabase.from("group_room_blocks").insert(payload as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Room block saved — the blocked rooms are held back from general sale");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReleaseBlock() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { block: string; reason: string }) =>
      callRpc<{ released: number }>("pms_group_release_block", { _block: input.block, _reason: input.reason }),
    onSuccess: (r) => {
      toast.success(`${r.released} unused room(s) released back to general availability`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useAddRoomingRow() {
  const { organizationId } = useAuth();
  const writeBranchId = useWriteBranchId();
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: async (input: {
      groupId: string;
      blockId: string | null;
      roomTypeId: string | null;
      guestName: string;
      email: string;
      phone: string;
      arrival: string;
      departure: string;
      adults: number;
      children: number;
      sharingWith: string;
      billingInstruction: string;
      complimentary: boolean;
      specialRequests: string;
    }) => {
      const { error } = await supabase.from("group_rooming_list").insert({
        organization_id: organizationId,
        branch_id: writeBranchId,
        group_booking_id: input.groupId,
        block_id: input.blockId,
        room_type_id: input.roomTypeId,
        guest_name: input.guestName,
        email: input.email || null,
        phone: input.phone || null,
        arrival_date: input.arrival,
        departure_date: input.departure,
        adults: input.adults,
        children: input.children,
        sharing_with: input.sharingWith || null,
        billing_instruction: input.billingInstruction || null,
        complimentary: input.complimentary,
        special_requests: input.specialRequests || null,
        status: "listed",
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Guest added to the rooming list");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useConvertRoomingRow() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { row: string; room?: string | null }) =>
      callRpc<{ confirmation_number?: string; already?: boolean }>("pms_group_convert_rooming", {
        _row: input.row,
        _room: input.room ?? null,
      }),
    onSuccess: (r) => {
      toast.success(r.already ? "This guest already has a reservation" : `Reservation ${r.confirmation_number} created from the block`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecordGroupDeposit() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { group: string; amount: number; method: string; reference: string }) =>
      callRpc<{ duplicate?: boolean }>("pms_group_record_deposit", {
        _group: input.group,
        _amount: input.amount,
        _method: input.method,
        _reference: input.reference,
      }),
    onSuccess: (r) => {
      toast.success(r.duplicate ? "That deposit reference was already recorded" : "Deposit posted to the group master folio");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}


export function useCreateGroupBooking() {
  const writeBranchId = useWriteBranchId();
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: async (input: {
      name: string; organizer?: string; groupType?: string; arrival: string; departure: string;
      rooms: number; guests: number; cutoff?: string | null; depositRequired?: number;
      billingInstructions?: string; status?: string;
    }) => {
      if (!writeBranchId) throw new Error("Select a property before creating a group booking");
      return callRpc<{ ok: boolean; id: string; reference: string }>("pms_group_create", {
        _payload: {
          branch_id: writeBranchId,
          name: input.name,
          organizer: input.organizer ?? null,
          group_type: input.groupType ?? "group",
          arrival_date: input.arrival,
          departure_date: input.departure,
          rooms_count: input.rooms,
          guests_count: input.guests,
          cutoff_date: input.cutoff ?? null,
          deposit_required: input.depositRequired ?? 0,
          billing_instructions: input.billingInstructions ?? null,
          status: input.status ?? "tentative",
        },
      });
    },
    onSuccess: (r) => {
      toast.success(`Group ${r.reference} created`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Waitlist
 * ------------------------------------------------------------------ */


export function useCreateWaitlistEntry() {
  const writeBranchId = useWriteBranchId();
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: async (input: {
      contactName: string; contactPhone?: string; contactEmail?: string; arrival: string; departure: string;
      roomTypeId?: string | null; adults: number; children: number; priority?: string; notes?: string;
    }) => {
      if (!writeBranchId) throw new Error("Select a property before adding a waitlist entry");
      return callRpc<{ ok: boolean; id: string }>("pms_waitlist_create", {
        _payload: {
          branch_id: writeBranchId,
          contact_name: input.contactName,
          contact_phone: input.contactPhone ?? null,
          contact_email: input.contactEmail ?? null,
          arrival_date: input.arrival,
          departure_date: input.departure,
          room_type_id: input.roomTypeId ?? null,
          adults: input.adults,
          children: input.children,
          priority: input.priority ?? "normal",
          notes: input.notes ?? null,
        },
      });
    },
    onSuccess: () => {
      toast.success("Guest added to the waitlist");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useOfferWaitlist() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { entry: string; rate: number | null; expires: string | null }) =>
      callRpc("pms_waitlist_offer", { _entry: input.entry, _rate: input.rate, _expires: input.expires }),
    onSuccess: () => {
      toast.success("Offer recorded — the entry now shows an expiry");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useConvertWaitlist() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { entry: string; room?: string | null }) =>
      callRpc<{ confirmation_number?: string; already?: boolean }>("pms_waitlist_convert", {
        _entry: input.entry,
        _room: input.room ?? null,
      }),
    onSuccess: (r) => {
      toast.success(r.already ? "Already converted" : `Reservation ${r.confirmation_number} created`);
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCloseWaitlist() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { entry: string; status: string; reason: string }) =>
      callRpc("pms_waitlist_close", { _entry: input.entry, _status: input.status, _reason: input.reason }),
    onSuccess: () => {
      toast.success("Waitlist entry closed with a recorded reason");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Guest requests
 * ------------------------------------------------------------------ */

export function useDepartmentsLite() {
  // Property-scoped, deduplicated department catalogue — never organisation-wide.
  const departments = useScopedDepartments();
  return { ...departments, data: departments.data ?? [] };
}

export function useAssignableStaff(departmentId?: string | null) {
  // Guest-request assignment follows the selected property -> department ->
  // worker chain. When no department is selected, do not expose a
  // property-wide worker catalogue to this selector.
  return useScopedWorkerOptions({
    departmentId: departmentId || null,
    enabled: Boolean(departmentId),
  });
}

export function useAssignRequest() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { request: string; assignee: string | null; department: string | null; reason: string }) =>
      callRpc("pms_request_assign", {
        _request: input.request,
        _assignee: input.assignee,
        _department: input.department,
        _reason: input.reason,
      }),
    onSuccess: () => {
      toast.success("Request reassigned — the new owner has been notified");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCompleteRequest() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { request: string; resolution: string; evidence: string }) =>
      callRpc("pms_request_complete", {
        _request: input.request,
        _resolution: input.resolution,
        _evidence: input.evidence,
      }),
    onSuccess: () => {
      toast.success("Request completed with resolution evidence");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRequestFeedback() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { request: string; rating: number; comment: string }) =>
      callRpc("pms_request_feedback", { _request: input.request, _rating: input.rating, _comment: input.comment }),
    onSuccess: () => {
      toast.success("Guest feedback recorded");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Folios — charges, transfers, reversals, reopening
 * ------------------------------------------------------------------ */

export function useFolio(id: string) {
  return useQuery({
    queryKey: ["pms", "folio", id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("folios")
        .select(
          "*, customers(id, full_name, email, phone), reservations(id, confirmation_number, arrival_date, departure_date, room_id, rooms(id, room_number)), corporate_accounts(id, legal_name), group_bookings(id, name, reference)",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useFolioLines(folioId: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pms", "folio-lines", folioId, filterKey],
    enabled: Boolean(folioId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("folio_lines").select("*"), "folio_lines")
        .eq("folio_id", folioId)
        .order("posting_date");
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useFolioPayments(folioId: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["pms", "folio-payments", folioId, filterKey],
    enabled: Boolean(folioId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("payments").select("*"), "payments")
        .eq("folio_id", folioId)
        .order("paid_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function usePostFolioCharge() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: {
      folio: string;
      category: string;
      description: string;
      quantity: number;
      unitPrice: number;
      tax: number;
      serviceCharge: number;
      discount: number;
      revenueCentre: string;
    }) =>
      callRpc("folio_post_charge", {
        _folio: input.folio,
        _category: input.category,
        _description: input.description,
        _quantity: input.quantity,
        _unit_price: input.unitPrice,
        _tax: input.tax,
        _service_charge: input.serviceCharge,
        _discount: input.discount,
        _source_module: "pms.folio",
        _source_record: null,
        _revenue_centre: input.revenueCentre || null,
        // No client-side key: a fresh UUID per attempt meant a double-click or a
        // retried request posted the same charge twice. The server derives a
        // deterministic key from the charge itself so a repeat submission of an
        // identical charge collapses onto the line already posted.
        _idempotency_key: null,
        _correlation: crypto.randomUUID(),
      }),
    onSuccess: () => {
      toast.success("Charge posted");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useTransferFolioLine() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { line: string; target: string; reason: string }) =>
      callRpc("folio_transfer_line", { _line: input.line, _target_folio: input.target, _reason: input.reason }),
    onSuccess: () => {
      toast.success("Charge transferred — the original posting stays on record");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReverseFolioLine() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { line: string; reason: string }) =>
      callRpc("folio_reverse_line", { _line: input.line, _reason: input.reason }),
    onSuccess: () => {
      toast.success("Reversal posted — nothing was deleted");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReopenFolio() {
  const invalidate = useInvalidate(["pms"]);
  return useMutation({
    mutationFn: (input: { folio: string; reason: string }) =>
      callRpc("folio_reopen", { _folio: input.folio, _reason: input.reason }),
    onSuccess: () => {
      toast.success("Folio reopened — the reason and actor are recorded");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useOpenFolios() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["pms", "open-folios", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("folios").select("id, folio_number, folio_type, customers(full_name)"), "folios")
        .eq("status", "open")
        .order("opened_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });
}

/* ------------------------------------------------------------------ *
 * Corporate credit accounts
 * ------------------------------------------------------------------ */

export function useCorporateAccounts(search: string) {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["credit", "accounts", organizationId, search, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let q = applyTo(supabase.from("corporate_accounts").select("*, corporate_credit_settings(*)"), "corporate_accounts")
        .order("legal_name")
        .limit(200);
      if (search.trim().length >= 2) q = q.ilike("legal_name", `%${search.trim()}%`);
      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAccountAging(accountId: string) {
  return useQuery({
    queryKey: ["credit", "aging", accountId],
    enabled: Boolean(accountId),
    queryFn: () => callRpc<AgingBucket[]>("corp_account_aging", { _account: accountId }),
  });
}

export type AgingBucket = { bucket: string; amount: number };

export type CreditCheck = {
  allowed: boolean;
  reasons: string[];
  exposure: number;
  credit_limit: number;
  available: number;
};

export function useCreditCheck(accountId: string, amount: number) {
  return useQuery({
    queryKey: ["credit", "check", accountId, amount],
    enabled: Boolean(accountId),
    queryFn: () =>
      callRpc<CreditCheck>("corp_credit_check", {
        _account: accountId,
        _branch: null,
        _customer: null,
        _amount: amount,
      }),
  });
}

export function useSaveCreditSettings() {
  const { organizationId } = useAuth();
  const invalidate = useInvalidate(["credit"]);
  return useMutation({
    mutationFn: async (input: {
      id?: string | null;
      accountId: string;
      creditStatus: string;
      creditLimit: number;
      paymentTermsDays: number;
      billingCycle: string;
      effectiveFrom: string | null;
      effectiveTo: string | null;
      suspensionReason: string;
    }) => {
      const payload = {
        organization_id: organizationId,
        corporate_account_id: input.accountId,
        credit_status: input.creditStatus,
        credit_limit: input.creditLimit,
        payment_terms_days: input.paymentTermsDays,
        billing_cycle: input.billingCycle,
        effective_from: input.effectiveFrom,
        effective_to: input.effectiveTo,
        suspension_reason: input.suspensionReason || null,
      };
      if (input.id) {
        const { error } = await supabase.from("corporate_credit_settings").update(payload as never).eq("id", input.id);
        if (error) throw error;
        return;
      }
      const { error } = await supabase.from("corporate_credit_settings").insert(payload as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Credit terms saved");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ------------------------------------------------------------------ *
 * Cashier shifts
 * ------------------------------------------------------------------ */

export function useShiftExpected(shiftId: string | null) {
  return useQuery({
    queryKey: ["pos", "shift-expected", shiftId],
    enabled: Boolean(shiftId),
    refetchInterval: 60_000,
    queryFn: () => callRpc<number>("cash_shift_expected", { _shift: shiftId }),
  });
}

export function useShiftMovements(shiftId: string | null) {
  return useQuery({
    queryKey: ["pos", "shift-movements", shiftId],
    enabled: Boolean(shiftId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cash_movements")
        .select("*")
        .eq("shift_id", shiftId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useOpenCashShift() {
  const invalidate = useInvalidate(["pos"]);
  return useMutation({
    mutationFn: (input: { branch: string | null; station: string | null; float: number }) =>
      callRpc<string>("cash_open_shift", {
        _branch: input.branch,
        _station: input.station,
        _float: input.float,
      }),
    onSuccess: () => {
      toast.success("Shift opened with a counted float");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecordCashMovement() {
  const invalidate = useInvalidate(["pos"]);
  return useMutation({
    mutationFn: (input: { shift: string; type: string; amount: number; reason: string; reference: string }) =>
      callRpc("cash_record_movement", {
        _shift: input.shift,
        _type: input.type,
        _amount: input.amount,
        _reason: input.reason,
        _reference: input.reference,
      }),
    onSuccess: () => {
      toast.success("Cash movement recorded");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useCloseCashShift() {
  const invalidate = useInvalidate(["pos"]);
  return useMutation({
    mutationFn: (input: { shift: string; counted: number; reason: string }) =>
      callRpc<{ variance: number; status: string }>("cash_close_shift", {
        _shift: input.shift,
        _counted: input.counted,
        _reason: input.reason,
      }),
    onSuccess: (r) => {
      toast.success(
        Number(r.variance) === 0
          ? "Shift closed and balanced"
          : `Shift closed with a variance of ${r.variance} — awaiting independent review`,
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewCashShift() {
  const invalidate = useInvalidate(["pos"]);
  return useMutation({
    mutationFn: (input: { shift: string; decision: string; notes: string }) =>
      callRpc("cash_review_shift", { _shift: input.shift, _decision: input.decision, _notes: input.notes }),
    onSuccess: () => {
      toast.success("Shift reviewed and posted to Finance");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
