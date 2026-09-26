/**
 * My Work — the personal, permission-scoped operating list.
 *
 * Every item is built inside the database by `neo_my_work`, which reads a block
 * only when the signed-in person's effective permissions already reach that
 * area. The browser never widens the reach: it simply renders what came back.
 * The property is whatever the global header is working in — there is no
 * second property selector.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type WorkTone = "critical" | "warning" | "info" | "ok";

export type WorkItem = {
  id: string;
  module: string;
  label: string;
  value: number;
  detail: string;
  route: string;
  tone: WorkTone;
};

export type MyWorkPayload = {
  authorised: boolean;
  reason?: string;
  generated_at?: string;
  timezone?: string;
  today?: string;
  branch_id?: string | null;
  items?: WorkItem[];
};

const TONE_RANK: Record<WorkTone, number> = { critical: 0, warning: 1, info: 2, ok: 3 };

/** Work items ordered by urgency, then by size. */
export function orderWork(items: WorkItem[]): WorkItem[] {
  return [...items].sort(
    (a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || Number(b.value) - Number(a.value),
  );
}

/** Only the items that actually need attention. */
export function attentionItems(items: WorkItem[]): WorkItem[] {
  return orderWork(items).filter((i) => i.tone !== "ok" && Number(i.value) > 0);
}

export function useMyWork(branchId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["my-work", branchId],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<MyWorkPayload> => {
      const { data, error } = await (supabase as any).rpc("neo_my_work", { _branch: branchId });
      if (error) throw new Error(error.message);
      return (data ?? { authorised: false }) as MyWorkPayload;
    },
  });
}
