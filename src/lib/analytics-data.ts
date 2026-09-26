/**
 * Phase 16 — Analytics data layer.
 *
 * Every read goes through a permission-checked `bi_*` database function or an
 * RLS-protected analytics table. The browser never supplies organization_id:
 * the database derives it from the session. Branch and date filters are hints
 * only — they narrow, they never widen.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { guardedRpc } from "@/lib/rpc-guard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { useBranchOptions as useSharedBranchOptions } from "@/lib/branches";
import { isoDate, type Row } from "@/lib/analytics";

const sb = supabase as unknown as {
  from: (t: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
};

const KEY = "analytics";

export type AnalyticsScope = {
  branchId: string | null;
  from: string;
  to: string;
};

export function defaultScope(days = 30): AnalyticsScope {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { branchId: null, from: isoDate(from), to: isoDate(to) };
}

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: [KEY] });
}

/** Audit wrapper carrying tenant + actor context for every analytics action. */
export function useAnalyticsAudit() {
  const { user, organizationId, profile } = useAuth();
  return async (action: string, recordId: string | null, newValue?: unknown, reason?: string) =>
    logAudit({
      organizationId: organizationId ?? null,
      userId: user?.id ?? null,
      userName: profile?.full_name ?? undefined,
      action,
      module: "analytics",
      recordId,
      newValue,
      reason: reason ?? null,
    });
}

/* ================================================================== *
 * Governed metric reads
 * ================================================================== */

export function useKpis(scope: AnalyticsScope, enabled = true) {
  return useQuery({
    queryKey: [KEY, "kpis", scope.branchId, scope.from, scope.to],
    enabled,
    refetchInterval: 120_000,
    queryFn: async (): Promise<Row> => {
      const { data, error } = await guardedRpc(sb, "bi_kpis", {
        _branch: scope.branchId,
        _from: scope.from,
        _to: scope.to,
      });
      fail(error);
      return (data ?? {}) as Row;
    },
  });
}

/** Same bundle for the immediately preceding period, for comparisons. */
export function useComparisonKpis(scope: AnalyticsScope, enabled = true) {
  const f = new Date(scope.from);
  const t = new Date(scope.to);
  const days = Math.max(Math.round((t.getTime() - f.getTime()) / 86_400_000) + 1, 1);
  const prev = {
    from: isoDate(new Date(f.getTime() - days * 86_400_000)),
    to: isoDate(new Date(t.getTime() - days * 86_400_000)),
  };
  return useQuery({
    queryKey: [KEY, "kpis-prev", scope.branchId, prev.from, prev.to],
    enabled,
    queryFn: async (): Promise<Row> => {
      const { data, error } = await guardedRpc(sb, "bi_kpis", {
        _branch: scope.branchId,
        _from: prev.from,
        _to: prev.to,
      });
      fail(error);
      return (data ?? {}) as Row;
    },
  });
}

export function useRevenueSeries(scope: AnalyticsScope, enabled = true) {
  return useQuery({
    queryKey: [KEY, "revenue-series", scope.branchId, scope.from, scope.to],
    enabled,
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await guardedRpc(sb, "bi_revenue_series", {
        _branch: scope.branchId,
        _from: scope.from,
        _to: scope.to,
      });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useOccupancySeries(scope: AnalyticsScope, enabled = true) {
  return useQuery({
    queryKey: [KEY, "occupancy-series", scope.branchId, scope.from, scope.to],
    enabled,
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await guardedRpc(sb, "bi_occupancy_series", {
        _branch: scope.branchId,
        _from: scope.from,
        _to: scope.to,
      });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useRevenueBreakdown(
  dimension: "department" | "branch" | "source",
  scope: AnalyticsScope,
  enabled = true,
) {
  return useQuery({
    queryKey: [KEY, "revenue-breakdown", dimension, scope.branchId, scope.from, scope.to],
    enabled,
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await guardedRpc(sb, "bi_revenue_breakdown", {
        _dimension: dimension,
        _branch: scope.branchId,
        _from: scope.from,
        _to: scope.to,
      });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export function useDataQuality(scope: AnalyticsScope, enabled = true) {
  return useQuery({
    queryKey: [KEY, "data-quality", scope.branchId],
    enabled,
    refetchInterval: 300_000,
    queryFn: async (): Promise<Row> => {
      const { data, error } = await guardedRpc(sb, "bi_data_quality_scan", { _branch: scope.branchId });
      fail(error);
      return (data ?? {}) as Row;
    },
  });
}

export function useRiskScan(scope: AnalyticsScope, days = 30, enabled = true) {
  return useQuery({
    queryKey: [KEY, "risk-scan", scope.branchId, days],
    enabled,
    refetchInterval: 300_000,
    queryFn: async (): Promise<Row> => {
      const { data, error } = await guardedRpc(sb, "bi_risk_scan", { _branch: scope.branchId, _days: days });
      fail(error);
      return (data ?? {}) as Row;
    },
  });
}

/* ================================================================== *
 * Generic table helpers for the governance tables
 * ================================================================== */

function useTable(table: string, order = "created_at", ascending = false, limit = 200) {
  return useQuery({
    queryKey: [KEY, table],
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await sb.from(table).select("*").order(order, { ascending }).limit(limit);
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

export const useMetricDefinitions = () => useTable("metric_definitions", "name", true);
export const useRecommendations = () => useTable("ai_recommendations");
export const useRiskRules = () => useTable("risk_rules", "name", true);
export const useRiskAlerts = () => useTable("risk_alerts");
export const useReportDefinitions = () => useTable("report_definitions", "name", true);
export const useReportSchedules = () => useTable("report_schedules");
export const useReportRuns = () => useTable("report_runs");
export const useGeneratedReports = () => useTable("generated_reports", "generated_at");
export const useReportDeliveries = () => useTable("report_deliveries");
export const useForecasts = () => useTable("forecasts", "generated_at");
export const useForecastActuals = () => useTable("forecast_actuals", "recorded_at");
export const useAiModels = () => useTable("ai_model_registry", "model_name", true);
export const usePromptVersions = () => useTable("ai_prompt_versions");
export const useAiFeatureLimits = () => useTable("ai_feature_limits", "feature", true);
export const useAiUsage = () => useTable("ai_usage_records", "created_at", false, 500);
export const useDataQualityIssues = () => useTable("data_quality_issues", "last_detected_at");
export const useRefreshJobs = () => useTable("analytics_refresh_jobs", "job_key", true);

export function useForecastValues(forecastId: string | null) {
  return useQuery({
    queryKey: [KEY, "forecast-values", forecastId],
    enabled: Boolean(forecastId),
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await sb
        .from("forecast_values")
        .select("*")
        .eq("forecast_id", forecastId)
        .order("target_date", { ascending: true });
      fail(error);
      return (data ?? []) as Row[];
    },
  });
}

/* ================================================================== *
 * Mutations
 * ================================================================== */

function useOrg() {
  const { organizationId, user } = useAuth();
  return { organizationId, userId: user?.id ?? null };
}

export function useSaveRow(table: string, label: string) {
  const invalidate = useInvalidate();
  const audit = useAnalyticsAudit();
  const { organizationId } = useOrg();
  return useMutation({
    mutationFn: async ({ id, values }: { id?: string | null; values: Row }) => {
      if (id) {
        const { data, error } = await sb.from(table).update(values).eq("id", id).select("id").single();
        fail(error);
        await audit(`${table}.update`, id, values);
        return data;
      }
      const { data, error } = await sb
        .from(table)
        .insert({ ...values, organization_id: organizationId })
        .select("id")
        .single();
      fail(error);
      await audit(`${table}.create`, (data as Row | null)?.["id"] ?? null, values);
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success(`${label} saved`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useDeleteRow(table: string, label: string) {
  const invalidate = useInvalidate();
  const audit = useAnalyticsAudit();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await sb.from(table).delete().eq("id", id);
      fail(error);
      await audit(`${table}.delete`, id);
    },
    onSuccess: () => {
      invalidate();
      toast.success(`${label} removed`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Persists a generated forecast together with every predicted point. */
export function useSaveForecast() {
  const invalidate = useInvalidate();
  const audit = useAnalyticsAudit();
  const { organizationId, userId } = useOrg();
  return useMutation({
    mutationFn: async (input: {
      metricCode: string;
      branchId: string | null;
      horizonDays: number;
      inputFrom: string;
      inputTo: string;
      sufficiency: string;
      limitations: string;
      modelVersion: string;
      points: { date: string; predicted: number; lower: number; upper: number }[];
    }) => {
      const { data, error } = await sb
        .from("forecasts")
        .insert({
          organization_id: organizationId,
          branch_id: input.branchId,
          metric_code: input.metricCode,
          model_version: input.modelVersion,
          horizon_days: input.horizonDays,
          input_period_start: input.inputFrom,
          input_period_end: input.inputTo,
          data_sufficiency: input.sufficiency,
          limitations: input.limitations,
          generated_by: userId,
        })
        .select("id")
        .single();
      fail(error);
      const forecastId = (data as Row)["id"] as string;
      if (input.points.length) {
        const { error: pe } = await sb.from("forecast_values").insert(
          input.points.map((p) => ({
            organization_id: organizationId,
            forecast_id: forecastId,
            target_date: p.date,
            predicted_value: p.predicted,
            lower_bound: p.lower,
            upper_bound: p.upper,
          })),
        );
        fail(pe);
      }
      await audit("forecast.generate", forecastId, {
        metric: input.metricCode,
        horizon: input.horizonDays,
        sufficiency: input.sufficiency,
      });
      return forecastId;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Forecast version saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Scores a stored forecast against recorded actuals; old versions are kept. */
export function useEvaluateForecast() {
  const invalidate = useInvalidate();
  const { organizationId } = useOrg();
  return useMutation({
    mutationFn: async ({
      forecastId,
      actuals,
    }: {
      forecastId: string;
      actuals: { date: string; predicted: number; actual: number }[];
    }) => {
      if (!actuals.length) throw new Error("No actuals recorded yet for this horizon");
      const { error } = await sb.from("forecast_actuals").upsert(
        actuals.map((a) => ({
          organization_id: organizationId,
          forecast_id: forecastId,
          target_date: a.date,
          predicted_value: a.predicted,
          actual_value: a.actual,
          absolute_error: Math.abs(a.predicted - a.actual),
          percentage_error: a.actual === 0 ? null : ((a.predicted - a.actual) / a.actual) * 100,
        })),
        { onConflict: "forecast_id,target_date" },
      );
      fail(error);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Forecast accuracy recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Stores a deterministic advisory so it can be reviewed, dismissed or actioned. */
export function useCaptureAdvisory() {
  const invalidate = useInvalidate();
  const audit = useAnalyticsAudit();
  const { organizationId } = useOrg();
  return useMutation({
    mutationFn: async (input: Row & { branchId?: string | null; from?: string; to?: string }) => {
      const reference = `${input["reference"]}-${Date.now().toString(36).toUpperCase()}`;
      const { data, error } = await sb
        .from("ai_recommendations")
        .insert({
          organization_id: organizationId,
          branch_id: input["branchId"] ?? null,
          reference,
          title: input["title"],
          category: input["category"],
          observation: input["observation"],
          recommended_action: input["recommendedAction"],
          expected_impact: input["expectedImpact"],
          confidence: input["confidence"],
          limitations: input["limitations"],
          supporting_data: { evidence: input["supporting"] ?? [] },
          generated_by: input["generatedBy"] ?? "rules",
          data_period_start: input["from"] ?? null,
          data_period_end: input["to"] ?? null,
          expires_at: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        })
        .select("id")
        .single();
      fail(error);
      await audit("recommendation.create", (data as Row)["id"] as string, { reference });
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Recommendation saved for review");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateRecommendation() {
  const invalidate = useInvalidate();
  const audit = useAnalyticsAudit();
  const { userId } = useOrg();
  return useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status: string; notes?: string }) => {
      const { error } = await sb
        .from("ai_recommendations")
        .update({ status, response_notes: notes ?? null, reviewed_by: userId })
        .eq("id", id);
      fail(error);
      await audit("recommendation.status", id, { status, notes });
    },
    onSuccess: () => {
      invalidate();
      toast.success("Recommendation updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Converts an advisory into a real task in the existing Phase 2 task system. */
export function useConvertRecommendationToTask() {
  const invalidate = useInvalidate();
  const audit = useAnalyticsAudit();
  const { organizationId, userId } = useOrg();
  return useMutation({
    mutationFn: async (rec: Row) => {
      const { data, error } = await sb
        .from("tasks")
        .insert({
          organization_id: organizationId,
          branch_id: rec["branch_id"] ?? null,
          department_id: rec["department_id"] ?? null,
          reference: `TSK-${Date.now().toString(36).toUpperCase()}`,
          title: rec["title"],
          description: `${rec["observation"]}\n\nRecommended action: ${rec["recommended_action"]}\n\nAdvisory only — confidence ${rec["confidence"]}. ${rec["limitations"] ?? ""}`,
          priority: "medium",
          status: "open",
          created_by: userId,
        })
        .select("id")
        .single();
      fail(error);
      const taskId = (data as Row)["id"] as string;
      const { error: ue } = await sb
        .from("ai_recommendations")
        .update({ status: "converted", task_id: taskId, reviewed_by: userId })
        .eq("id", rec["id"]);
      fail(ue);
      await audit("recommendation.convert_to_task", rec["id"] as string, { taskId });
      return taskId;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Task created from recommendation");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Raises a reviewable risk alert from a detected signal. Never accusatory. */
export function useRaiseRiskAlert() {
  const invalidate = useInvalidate();
  const audit = useAnalyticsAudit();
  const { organizationId } = useOrg();
  return useMutation({
    mutationFn: async (input: {
      branchId: string | null;
      ruleCode: string;
      category: string;
      severity: string;
      observed: number;
      explanation: string;
      from: string;
      to: string;
    }) => {
      const alertNumber = `RSK-${Date.now().toString(36).toUpperCase()}`;
      const { data, error } = await sb
        .from("risk_alerts")
        .insert({
          organization_id: organizationId,
          branch_id: input.branchId,
          alert_number: alertNumber,
          rule_code: input.ruleCode,
          category: input.category,
          severity: input.severity,
          observed_value: input.observed,
          explanation: input.explanation,
          data_period_start: input.from,
          data_period_end: input.to,
        })
        .select("id")
        .single();
      fail(error);
      await audit("risk_alert.raise", (data as Row)["id"] as string, { alertNumber, code: input.ruleCode });
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Risk alert raised — requires review");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useUpdateRiskAlert() {
  const invalidate = useInvalidate();
  const audit = useAnalyticsAudit();
  return useMutation({
    mutationFn: async ({ id, status, notes }: { id: string; status: string; notes?: string }) => {
      const { error } = await sb
        .from("risk_alerts")
        .update({ status, investigation_notes: notes ?? null })
        .eq("id", id);
      fail(error);
      await audit("risk_alert.status", id, { status });
    },
    onSuccess: () => {
      invalidate();
      toast.success("Risk alert updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/** Records a generated report in the library. Delivery remains Not Configured. */
export function useGenerateReport() {
  const invalidate = useInvalidate();
  const audit = useAnalyticsAudit();
  const { organizationId, userId } = useOrg();
  return useMutation({
    mutationFn: async (input: {
      reportId: string;
      name: string;
      reportType: string;
      branchId: string | null;
      from: string;
      to: string;
      sensitive: boolean;
      payload: Row;
    }) => {
      const idem = `${input.reportId}:${input.from}:${input.to}:${input.branchId ?? "all"}`;
      const { data: run, error: re } = await sb
        .from("report_runs")
        .insert({
          organization_id: organizationId,
          report_id: input.reportId,
          branch_id: input.branchId,
          data_period_start: input.from,
          data_period_end: input.to,
          status: "succeeded",
          idempotency_key: idem,
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          triggered_by: userId,
        })
        .select("id")
        .single();
      fail(re);
      const { data, error } = await sb
        .from("generated_reports")
        .insert({
          organization_id: organizationId,
          branch_id: input.branchId,
          run_id: (run as Row)["id"],
          report_id: input.reportId,
          name: input.name,
          report_type: input.reportType,
          data_period_start: input.from,
          data_period_end: input.to,
          format: "json",
          payload: input.payload,
          sensitive: input.sensitive,
          source_version: "bi_kpis@v1",
          generated_by: userId,
          expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        })
        .select("id")
        .single();
      fail(error);
      await audit("report.generate", (data as Row)["id"] as string, { name: input.name, from: input.from, to: input.to });
      return data;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Report generated into the library");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useRecordAiFeedback() {
  const invalidate = useInvalidate();
  const { organizationId, userId } = useOrg();
  return useMutation({
    mutationFn: async ({ messageId, rating, comment }: { messageId?: string; rating: string; comment?: string }) => {
      const { error } = await sb.from("ai_feedback").insert({
        organization_id: organizationId,
        user_id: userId,
        message_id: messageId ?? null,
        rating,
        comment: comment ?? null,
      });
      fail(error);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Thank you — feedback recorded");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

/* ================================================================== *
 * Scope options
 * ================================================================== */

/** Analytics property picker — projects the shared organisation-scoped list. */
export function useBranchOptions() {
  return useSharedBranchOptions({ activeOnly: true });
}

