/**
 * Duplicate people resolver.
 *
 * Matching is done in the database on email, phone and recorded identity
 * documents. Nothing is ever merged by the scan: a candidate is written to the
 * register, a human confirms or rejects it with a written judgement, and only
 * a confirmed candidate can be merged. The merge itself is handed to the
 * canonical guest-merge routine so there is a single audit trail.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const sb = supabase as unknown as {
  from: (t: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

const KEY = "duplicate-resolver";

export type DuplicateEntity = "customer" | "employee";

export type DuplicateCandidate = {
  id: string;
  entity_type: DuplicateEntity;
  primary_id: string;
  duplicate_id: string;
  match_score: number;
  match_reasons: string[];
  evidence: Row;
  status: "pending" | "confirmed" | "rejected" | "merged";
  decision_note: string | null;
  reviewed_at: string | null;
  merged_at: string | null;
  created_at: string;
};

export const MATCH_REASON_LABEL: Record<string, string> = {
  email: "Same email address",
  phone: "Same phone number",
  identifier: "Same identity document",
  name: "Same name",
};

async function rpc<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await guardedRpc(sb, name, args ?? {});
  if (error) throw new Error(error.message);
  return data as T;
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: [KEY] });
}

export function useDuplicateRegister(entity: DuplicateEntity, organizationId: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, entity, organizationId ?? null],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await sb
        .from("person_duplicate_candidates")
        .select("*")
        .eq("entity_type", entity)
        .order("status", { ascending: true })
        .order("match_score", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []) as DuplicateCandidate[];
    },
  });
}

/** Names for the two sides of each candidate, read from the live records. */
export function useDuplicatePeople(entity: DuplicateEntity, ids: string[]) {
  const key = [...new Set(ids)].sort().join(",");
  return useQuery({
    queryKey: [KEY, "people", entity, key],
    enabled: ids.length > 0,
    queryFn: async () => {
      const table = entity === "customer" ? "customers" : "employees";
      const columns =
        entity === "customer"
          ? "id, full_name, customer_number, email, phone, created_at"
          : "id, full_name, employee_number, work_email, personal_email, phone, created_at";
      const { data, error } = await sb.from(table).select(columns).in("id", [...new Set(ids)]);
      if (error) throw new Error(error.message);
      const map: Record<string, Row> = {};
      for (const row of (data ?? []) as Row[]) map[row["id"] as string] = row;
      return map;
    },
  });
}

export function useScanDuplicates() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (entity: DuplicateEntity) => rpc<Row>("neo_scan_person_duplicates", { _entity_type: entity }),
    onSuccess: (result) => {
      invalidate();
      toast.success(
        `${result?.["new_candidates"] ?? 0} new possible duplicate(s) added — ${result?.["matches_found"] ?? 0} match(es) seen in total`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useReviewDuplicate() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: { candidate: string; decision: "confirmed" | "rejected"; note: string }) =>
      rpc("neo_review_person_duplicate", {
        _candidate: input.candidate,
        _decision: input.decision,
        _note: input.note,
      }),
    onSuccess: (_d, input) => {
      invalidate();
      toast.success(input.decision === "confirmed" ? "Confirmed as the same person" : "Recorded as different people");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function useMergeDuplicate() {
  const invalidate = useInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { candidate: string; survivor: string; reason: string }) =>
      rpc("neo_merge_person_duplicate", {
        _candidate: input.candidate,
        _survivor: input.survivor,
        _reason: input.reason,
      }),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ["crm"] });
      toast.success("Records merged — the losing record is kept for audit");
    },
    onError: (e: Error) => toast.error(e.message),
  });
}
