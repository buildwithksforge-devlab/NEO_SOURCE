/**
 * Simulation Centre — browser data access.
 *
 * Reads come straight from the test registry under the workspace's own row
 * level security; the privileged actions go through server functions.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  cleanTestEnvironment,
  createTestEnvironment,
  runSystemTest,
} from "@/lib/simulation.functions";

export type TestRun = {
  id: string;
  run_ref: string;
  environment: string;
  status: string;
  totals: {
    tests?: number;
    passed?: number;
    warnings?: number;
    failed?: number;
    critical?: number;
    skipped?: number;
  };
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  current_suite: string | null;
  failure_detail: string | null;
};

export type TestResult = {
  id: string;
  run_id: string;
  suite: string;
  suite_order: number;
  case_key: string;
  name: string;
  status: "pass" | "warn" | "fail" | "critical" | "skip";
  severity: string;
  duration_ms: number;
  assertions: { label: string; ok: boolean; expected?: unknown; actual?: unknown }[];
  evidence: Record<string, unknown>;
  detail: string | null;
};

export type TestEnvironmentRow = {
  id: string;
  label: string;
  kind: string;
  status: string;
  test_org_id: string | null;
  created_at: string;
};

export function useTestEnvironments() {
  return useQuery({
    queryKey: ["simulation-environments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("neo_test_environments" as never)
        .select("id, label, kind, status, test_org_id, created_at")
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as TestEnvironmentRow[];
    },
  });
}

export function useTestRunsHistory() {
  return useQuery({
    queryKey: ["simulation-runs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("neo_test_runs" as never)
        .select(
          "id, run_ref, environment, status, totals, started_at, finished_at, duration_ms, current_suite, failure_detail",
        )
        .order("started_at", { ascending: false })
        .limit(30);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as TestRun[];
    },
    refetchInterval: 10_000,
  });
}

export function useTestResults(runId: string | null) {
  return useQuery({
    queryKey: ["simulation-results", runId],
    enabled: Boolean(runId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("neo_test_results" as never)
        .select("*")
        .eq("run_id", runId!)
        .order("suite_order", { ascending: true })
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as TestResult[];
    },
    refetchInterval: 10_000,
  });
}

export function useCreateTestEnvironment() {
  const client = useQueryClient();
  const fn = useServerFn(createTestEnvironment);
  return useMutation({
    mutationFn: async () => fn({}),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["simulation-environments"] }),
  });
}

export function useRunSystemTest() {
  const client = useQueryClient();
  const fn = useServerFn(runSystemTest);
  return useMutation({
    mutationFn: async () => fn({}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["simulation-runs"] });
      void client.invalidateQueries({ queryKey: ["simulation-results"] });
    },
  });
}

export function useCleanTestEnvironment() {
  const client = useQueryClient();
  const fn = useServerFn(cleanTestEnvironment);
  return useMutation({
    mutationFn: async () => fn({}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["simulation-environments"] });
      void client.invalidateQueries({ queryKey: ["simulation-runs"] });
    },
  });
}
