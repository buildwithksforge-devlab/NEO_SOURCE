import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { DISPLAY_ROUTES, stationDepartment, type DisplayStation } from "@/lib/production-displays";

export async function resolveStationAccountEntry(property?: string) {
  const result = await guardedRpc<(DisplayStation & { branch_id: string }) | null>(
    supabase, "neo_station_login_destination", property ? { _branch: property } : {},
  ).catch(() => null);
  // An unavailable optional landing destination still allows normal sign-in.
  const data = result?.data;
  if (result?.error || !data?.id || !data.branch_id || (property && data.branch_id !== property)) return undefined;
  const department = stationDepartment(data);
  if (!department) return undefined;
  return `${DISPLAY_ROUTES[department]}?${new URLSearchParams({ property: data.branch_id, station: data.id })}`;
}
