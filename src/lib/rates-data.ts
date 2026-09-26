/**
 * Rates, packages and meal plans — the one authoritative pricing source.
 *
 * Every Front Office screen that needs a nightly price calls `useRateQuote`,
 * which delegates to `public.pms_quote_rate()`. The calculation (occupancy
 * supplements, child pricing, day-of-week applicability, validity window,
 * stay restrictions, service charge and tax) therefore lives next to the data
 * and cannot drift between the reservation form, group bookings and folios.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useWriteBranchId } from "@/lib/branch-filter";
import { logAudit } from "@/lib/audit";
import { normalizeWeekdays } from "@/lib/weekdays";

export type RateQuote = {
  ok: boolean;
  reason?: string;
  rate_plan_id?: string;
  rate_plan?: string;
  meal_plan_id?: string | null;
  room_type_id?: string | null;
  currency?: string;
  nights?: number;
  priced_nights?: number;
  nightly_rate?: number;
  extra_adult_charge?: number;
  child_charge?: number;
  subtotal?: number;
  service_charge?: number;
  tax_amount?: number;
  tax_treatment?: string;
  total_amount?: number;
  cancellation_policy?: string | null;
  deposit_policy?: string | null;
  restrictions?: string[];
};

export function useRateQuote(params: {
  ratePlanId: string | null;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["rates", "quote", params],
    enabled: (params.enabled ?? true) && Boolean(params.ratePlanId && params.arrival && params.departure),
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "pms_quote_rate", {
        _rate_plan: params.ratePlanId,
        _arrival: params.arrival,
        _departure: params.departure,
        _adults: params.adults,
        _children: params.children,
      } as never);
      if (error) throw error;
      return data as unknown as RateQuote;
    },
  });
}

/* ------------------------------------------------------------------ *
 * Configuration mutations — RLS enforces front-office.rates.manage and
 * front-office.meal-plans.manage, so an unauthorised write is refused by
 * the database even if a control were ever rendered by mistake.
 * ------------------------------------------------------------------ */

function useInvalidateRates() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ["pms"] });
    void qc.invalidateQueries({ queryKey: ["rates"] });
  };
}

export type RatePlanInput = {
  id?: string;
  name: string;
  code: string;
  description: string;
  room_type_id: string | null;
  meal_plan_id: string | null;
  base_rate: number;
  currency: string;
  tax_treatment: string;
  tax_rate: number;
  service_charge_rate: number;
  included_occupancy: number;
  extra_adult_charge: number;
  child_per_night: number;
  extra_bed_charge: number;
  min_stay: number | null;
  max_stay: number | null;
  valid_from: string | null;
  valid_to: string | null;
  /** Canonical ISO weekdays (Mon = 1 … Sun = 7). Empty means every day. */
  days_of_week: number[];
  corporate_only: boolean;
  cancellation_policy: string;
  deposit_policy: string;
  status: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Blank optional inputs become null; never an empty string. */
const nullableUuid = (v: string | null | undefined, field: string) => {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (!UUID.test(s)) throw new Error(`${field}: expected a valid record reference.`);
  return s;
};
const nullableDate = (v: string | null | undefined, field: string) => {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (!ISO_DATE.test(s) || Number.isNaN(Date.parse(s))) throw new Error(`${field}: use a valid date (YYYY-MM-DD).`);
  return s;
};
const nullableInt = (v: number | null | undefined, field: string) => {
  if (v === null || v === undefined || (v as unknown) === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${field}: enter a whole number of nights or leave it blank.`);
  return Math.floor(n);
};
const requiredNumber = (v: number | null | undefined, field: string, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${field}: enter a valid amount.`);
  return n;
};

/** Field-level validation and canonical normalisation for a rate plan. */
export function buildRatePlanRow(input: RatePlanInput) {
  const name = input.name.trim();
  const code = input.code.trim().toUpperCase();
  if (!name) throw new Error("Rate plan name is required.");
  if (!code) throw new Error("Rate plan code is required.");
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency: use a three-letter code such as KES.");
  if (!["exclusive", "inclusive"].includes(input.tax_treatment))
    throw new Error("Tax treatment must be inclusive or exclusive.");

  const min_stay = nullableInt(input.min_stay, "Minimum stay");
  const max_stay = nullableInt(input.max_stay, "Maximum stay");
  if (min_stay !== null && max_stay !== null && max_stay > 0 && max_stay < min_stay)
    throw new Error("Maximum stay cannot be shorter than the minimum stay.");

  const valid_from = nullableDate(input.valid_from, "Effective from");
  const valid_to = nullableDate(input.valid_to, "Effective to");
  if (valid_from && valid_to && valid_to < valid_from)
    throw new Error("Effective to must fall on or after the effective from date.");

  return {
    name,
    code,
    description: input.description.trim(),
    room_type_id: nullableUuid(input.room_type_id, "Room type"),
    meal_plan_id: nullableUuid(input.meal_plan_id, "Meal plan"),
    base_rate: requiredNumber(input.base_rate, "Base rate"),
    currency,
    tax_treatment: input.tax_treatment,
    tax_rate: requiredNumber(input.tax_rate, "Tax rate", 100),
    service_charge_rate: requiredNumber(input.service_charge_rate, "Service charge rate", 100),
    included_occupancy: Math.max(1, Math.floor(Number(input.included_occupancy ?? 1))),
    extra_adult_charge: requiredNumber(input.extra_adult_charge, "Extra adult charge"),
    child_pricing: { per_child: requiredNumber(input.child_per_night, "Child charge") },
    extra_bed_charge: requiredNumber(input.extra_bed_charge, "Extra bed charge"),
    min_stay,
    max_stay,
    valid_from,
    valid_to,
    // Canonical ISO integers — never the UI label or a lowercase string.
    days_of_week: normalizeWeekdays(input.days_of_week).length
      ? normalizeWeekdays(input.days_of_week)
      : null,
    corporate_only: Boolean(input.corporate_only),
    cancellation_policy: input.cancellation_policy.trim(),
    deposit_policy: input.deposit_policy.trim(),
    status: input.status,
  };
}

export function useSaveRatePlan() {
  const { organizationId, user, can } = useAuth();
  const writeBranchId = useWriteBranchId();
  const invalidate = useInvalidateRates();
  return useMutation({
    mutationFn: async (input: RatePlanInput) => {
      if (!organizationId) throw new Error("No organisation context — sign in to a workspace first.");
      if (!can("front-office", "rates", "manage"))
        throw new Error("front-office.rates.manage is required to save a rate plan.");
      const row = {
        organization_id: organizationId,
        branch_id: writeBranchId,
        ...buildRatePlanRow(input),
      };
      const correlationId = crypto.randomUUID();

      if (input.id) {
        const { data, error } = await supabase
          .from("rate_plans")
          .update(row as never)
          .eq("id", input.id)
          .select("*")
          .maybeSingle();
        if (error) throw new Error(friendlyRateError(error));
        if (!data) throw new Error("Rate plan could not be updated — it may be outside your property scope.");
        await logAudit({
          organizationId,
          action: "rate_plan.updated",
          module: "front-office",
          recordId: input.id,
          newValue: row,
          permissionUsed: "front-office.rates.manage",
          correlationId,
          branchId: writeBranchId,
        });
        return data;
      }

      // Idempotent create: a repeated submit resolves onto the same row rather
      // than producing a duplicate plan code within the workspace.
      const { data, error } = await supabase
        .from("rate_plans")
        .upsert({ ...row, created_by: user?.id ?? null } as never, {
          onConflict: "organization_id,code",
          ignoreDuplicates: false,
        })
        .select("*")
        .maybeSingle();
      if (error) throw new Error(friendlyRateError(error));
      if (!data) throw new Error("Rate plan was not returned by the database — nothing was saved.");
      await logAudit({
        organizationId,
        action: "rate_plan.created",
        module: "front-office",
        recordId: (data as { id: string }).id,
        newValue: row,
        permissionUsed: "front-office.rates.manage",
        correlationId,
        branchId: writeBranchId,
      });
      return data;
    },
    onSuccess: () => {
      toast.success("Rate plan saved");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Turns Postgres failures into a truthful, field-aware message. */
function friendlyRateError(error: { code?: string; message: string; details?: string | null }) {
  if (error.code === "23505") return "A rate plan with this code already exists in this workspace.";
  if (error.code === "42501") return "Access denied — front-office.rates.manage is required for this property.";
  if (error.code === "22P02") return `Invalid value sent to the database: ${error.message}`;
  if (error.code === "23514") return "One of the values is outside the allowed range (check weekdays and rates).";
  return error.message;
}


export function useArchiveRatePlan() {
  const invalidate = useInvalidateRates();
  return useMutation({
    mutationFn: async (input: { id: string; status: string }) => {
      const { error } = await supabase.from("rate_plans").update({ status: input.status } as never).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Rate plan status updated");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export type MealPlanInput = {
  id?: string;
  code: string;
  name: string;
  description: string;
  includes: string[];
  status: string;
};

export function useSaveMealPlan() {
  const { organizationId, user } = useAuth();
  const writeBranchId = useWriteBranchId();
  const invalidate = useInvalidateRates();
  return useMutation({
    mutationFn: async (input: MealPlanInput) => {
      if (!organizationId) throw new Error("No organisation context");
      const row = {
        organization_id: organizationId,
        branch_id: writeBranchId,
        code: input.code.trim().toUpperCase(),
        name: input.name.trim(),
        description: input.description.trim(),
        includes: input.includes,
        status: input.status,
      };
      if (input.id) {
        const { error } = await supabase.from("meal_plans").update(row as never).eq("id", input.id);
        if (error) throw error;
        return;
      }
      const { error } = await supabase
        .from("meal_plans")
        .insert({ ...row, created_by: user?.id ?? null } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Meal plan saved");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
