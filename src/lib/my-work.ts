/**
 * My Work — the personal, permission-scoped operating list.
 *
 * Every item is built inside the database by `neo_my_work`, which reads a block
 * only when the signed-in person's effective permissions already reach that
 * area. The browser never widens the reach: it simply renders what came back.
 * The property is whatever the global header is working in — there is no
 * second property selector.
 */
import { useAuth } from "@/lib/auth";
import { guardedRpc } from "@/lib/rpc-guard";
import { isSchemaMismatch } from "@/lib/query-telemetry";
import { isPermissionDeniedError } from "@/lib/rpc-telemetry";
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

export class MyWorkContractError extends Error {}

/** Invalid responses are not an empty, successful workday. */
export function parseMyWorkPayload(value: unknown): MyWorkPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MyWorkContractError("My work returned an invalid response. Refresh or report this error.");
  const payload = value as Record<string, unknown>;
  if (typeof payload["authorised"] !== "boolean") throw new MyWorkContractError("My work did not confirm access.");
  if (!payload["authorised"]) return { authorised: false, reason: typeof payload["reason"] === "string" ? payload["reason"] : "not_authorised", items: [] };
  if (!Array.isArray(payload["items"])) throw new MyWorkContractError("My work returned no valid work list.");
  const ids = new Set<string>();
  for (const value of payload["items"]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new MyWorkContractError("My work contains an invalid item.");
    const item = value as Record<string, unknown>;
    for (const key of ["id", "module", "label", "detail", "route", "tone"]) {
      if (typeof item[key] !== "string" || (key !== "detail" && !(item[key] as string).trim())) throw new MyWorkContractError("My work contains an incomplete item.");
    }
    const id = item["id"] as string, route = item["route"] as string;
    if (ids.has(id) || !route.startsWith("/") || route.startsWith("//") || route.includes(String.fromCharCode(92)) || !Object.hasOwn(TONE_RANK, item["tone"] as string)
        || typeof item["value"] !== "number" || !Number.isFinite(item["value"]) || item["value"] < 0) {
      throw new MyWorkContractError("My work contains an invalid count, destination or duplicate item.");
    }
    ids.add(id);
  }
  return payload as MyWorkPayload;
}

export function useMyWork(branchId: string | null, enabled = true) {
  const { organizationId, user, phase, permissions, access, permissionsLoaded, accessLoaded } = useAuth();
  const authority = JSON.stringify({ permissions: [...permissions].sort(), scope: access.accessScope,
    branches: [...access.branchIds].sort(), departments: [...access.departmentIds].sort(), stations: [...access.stationIds].sort(), roles: [...access.roleIds].sort() });
  return useQuery({
    queryKey: ["my-work", organizationId, user?.id ?? null, branchId, authority],
    enabled: enabled && phase === "ready" && permissionsLoaded && accessLoaded && Boolean(organizationId && user?.id),
    staleTime: 60_000,
    retry: (failures, error) => failures < 2 && !(error instanceof MyWorkContractError) && !isSchemaMismatch(error) && !isPermissionDeniedError(error),
    queryFn: async (): Promise<MyWorkPayload> => {
      const { data, error } = await guardedRpc(supabase, "neo_my_work", { _branch: branchId });
      if (error) throw Object.assign(new Error(error.message), { code: error.code });
      return parseMyWorkPayload(data);
    },
  });
}
