/**
 * Commitments — overdue obligations and blocked operational items for the
 * signed-in reader.
 *
 * The list is produced by `neo_commitments`, which resolves organisation,
 * property and capability inside the database: an item the reader may not see
 * is never returned. Each row carries one stable key, so the same obligation
 * cannot appear twice however many notices were raised for it, and one deep
 * link to the screen that clears it.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

/* eslint-disable @typescript-eslint/no-explicit-any */
const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as any).rpc(fn, args) as Promise<{ data: any; error: { message: string } | null }>;

export type Commitment = {
  key: string;
  kind: "commitment" | "blocked";
  module: string;
  title: string;
  detail: string;
  severity: "high" | "medium" | "low";
  due_at: string | null;
  overdue_minutes: number | null;
  drill_to: string;
  reference: string | null;
};

export function useCommitments(branchId: string | null = null, limit = 200) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["commitments", organizationId, branchId, limit],
    enabled: Boolean(organizationId),
    refetchInterval: 60_000,
    queryFn: async (): Promise<Commitment[]> => {
      const { data, error } = await rpc("neo_commitments", { _branch: branchId, _limit: limit });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Commitment[];
      // The database already returns one row per key; this guards against a
      // caller merging two scopes into one list.
      const seen = new Set<string>();
      return rows.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
    },
  });
}

export function overdueLabel(minutes: number | null): string {
  if (minutes === null || minutes === undefined) return "No due time recorded";
  if (minutes < 60) return `${minutes} min overdue`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h overdue`;
  return `${Math.floor(hours / 24)} days overdue`;
}
