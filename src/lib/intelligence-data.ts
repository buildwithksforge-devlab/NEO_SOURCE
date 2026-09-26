/**
 * NEØ Intelligence — scoped, deterministic data layer.
 *
 * Everything on /ai-insights comes from `neo_intelligence`, which resolves
 * organisation, property, period and capability inside the database. Nothing
 * here estimates, extrapolates or fabricates: a figure that cannot be derived
 * from operational records is reported as missing, never guessed.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as any).rpc(fn, args) as Promise<{ data: any; error: { message: string } | null }>;

export type IntelligenceScope = {
  branchId: string | null;
  from: string;
  to: string;
};

export type DemandPoint = { day: string; occupied?: number; occupancy?: number | null; on_the_books?: number; sellable?: number };

export type RateSuggestion = {
  room_type: string;
  rate_plan: string | null;
  current_rate: number | null;
  currency: string;
  rooms_of_type: number;
  on_the_books_next_14: number;
  direction: string;
  evidence: string;
};

export type Anomaly = {
  key: string;
  severity: "ok" | "info" | "warning" | "critical";
  title: string;
  detail: string;
  evidence: string;
  drill_to: string;
};

export type DepartmentAdvisory = { department: string; headline: string; drill_to: string };

export type IntelligencePayload = {
  authorised: boolean;
  reason?: string;
  generated_at?: string;
  timezone?: string;
  currency?: string;
  money_visible?: boolean;
  period?: { from: string; to: string; days: number };
  briefing?: Record<string, number | boolean | null>;
  demand?: {
    history: DemandPoint[];
    forward: DemandPoint[];
    sample_days: number;
    average_occupancy: number | null;
    sufficient: boolean;
    method: string;
    confidence: "high" | "moderate" | "insufficient";
  };
  rate_suggestions?: RateSuggestion[];
  anomalies?: Anomaly[];
  menu?: {
    items_total: number;
    items_costed: number;
    coverage_percent: number | null;
    items: { item: string; price: number | null; cost: number | null; margin_percent: number | null }[];
    note: string;
  };
  sentiment?: {
    responses: number;
    average_rating: number | null;
    detractors: number;
    method: string;
    note: string;
    themes: { category: string; responses: number; average_rating: number }[];
  };
  departments?: DepartmentAdvisory[];
};

export function useIntelligence(scope: IntelligenceScope, enabled = true) {
  return useQuery({
    queryKey: ["neo-intelligence", scope.branchId, scope.from, scope.to],
    enabled,
    refetchInterval: 120_000,
    queryFn: async (): Promise<IntelligencePayload> => {
      const { data, error } = await rpc("neo_intelligence", {
        _branch: scope.branchId,
        _from: scope.from,
        _to: scope.to,
      });
      if (error) throw new Error(error.message);
      return (data ?? { authorised: false }) as IntelligencePayload;
    },
  });
}

export type OutboxHealth = {
  authorised: boolean;
  reason?: string;
  generated_at?: string;
  pending?: number;
  retrying?: number;
  processing?: number;
  dead_lettered?: number;
  failed?: number;
  processed_24h?: number;
  oldest_pending_at?: string | null;
};

export function useOutboxHealth(branchId: string | null = null) {
  return useQuery({
    queryKey: ["neo-outbox-health", branchId],
    refetchInterval: 60_000,
    queryFn: async (): Promise<OutboxHealth> => {
      const { data, error } = await rpc("neo_outbox_health", { _branch: branchId });
      if (error) throw new Error(error.message);
      return (data ?? { authorised: false }) as OutboxHealth;
    },
  });
}

export type OutboxFailure = {
  id: string;
  event_type: string;
  source_module: string | null;
  source_record_id: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  occurred_at: string;
  next_attempt_at: string | null;
  dead_lettered_at: string | null;
};

export function useOutboxFailures(branchId: string | null = null, limit = 50) {
  return useQuery({
    queryKey: ["neo-outbox-failures", branchId, limit],
    refetchInterval: 60_000,
    queryFn: async (): Promise<OutboxFailure[]> => {
      const { data, error } = await rpc("neo_outbox_failures", { _branch: branchId, _limit: limit });
      if (error) throw new Error(error.message);
      return (data ?? []) as OutboxFailure[];
    },
  });
}

/** Money is formatted, never rounded into existence: null stays "—". */
export function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  void currency;
  return new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(n);
}

export function count(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n)) : "—";
}

export function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(1)}%` : "—";
}
