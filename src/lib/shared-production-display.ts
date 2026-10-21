import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import type { KitchenTicket } from "@/lib/kitchen-tickets";

export const DISPLAY_TOKEN_STORAGE_KEY = "neo.production.display.token.v1";
export type SharedDisplayAction = {
  ticketId: string;
  to: string;
  expected: string;
  requestId: string;
  reason: string;
};
export type SharedDisplaySnapshot = {
  ok: boolean;
  session_id: string;
  label: string;
  property: string;
  read_only: boolean;
  expires_at: string;
  server_time: string;
  blocked_until: string | null;
  stations: { id: string; name: string }[];
  tickets: (KitchenTicket & { claimed_by?: string | null })[];
};
export type DisplayActionResult = {
  ok: boolean;
  reason?: string;
  message?: string;
  actor_name?: string;
  idempotent?: boolean;
};

export function productionActions(status: string): string[] {
  return (
    (
      {
        new: ["accepted"],
        accepted: ["preparing"],
        preparing: ["ready"],
        "partially-ready": ["ready"],
      } as Record<string, string[]>
    )[status] ?? []
  );
}

export async function readSharedDisplay(token: string): Promise<SharedDisplaySnapshot> {
  const { data, error } = await guardedRpc<SharedDisplaySnapshot>(
    supabase,
    "neo_production_display_read",
    { _token: token },
  );
  if (error) throw new Error(error.message);
  return data;
}
export async function actOnSharedDisplay(
  token: string,
  code: string,
  pin: string,
  action: SharedDisplayAction,
): Promise<DisplayActionResult> {
  const { data, error } = await guardedRpc<DisplayActionResult>(
    supabase,
    "neo_production_display_act",
    {
      _token: token,
      _code: code.trim().toUpperCase(),
      _pin: pin,
      _ticket: action.ticketId,
      _to: action.to,
      _expected: action.expected,
      _request: action.requestId,
      _reason: action.reason || null,
    },
  );
  if (error) throw new Error(error.message);
  return data;
}

export async function pairSharedDisplay(
  branchId: string,
  stationIds: string[],
  label: string,
  readOnly: boolean,
) {
  const { data, error } = await guardedRpc<{ ok: boolean; token: string; session_id: string }>(
    supabase,
    "neo_production_display_pair",
    {
      _branch: branchId,
      _stations: stationIds,
      _label: label,
      _read_only: readOnly,
    },
  );
  if (error) throw new Error(error.message);
  try {
    // Persist only the restricted token, never the supervisor's JWT or a PIN.
    sessionStorage.setItem(DISPLAY_TOKEN_STORAGE_KEY, data.token);
    const result = await supabase.auth.signOut({ scope: "local" });
    if (result.error) throw result.error;
  } catch (error) {
    sessionStorage.removeItem(DISPLAY_TOKEN_STORAGE_KEY);
    // Pairing failed: revoke the unused restricted session if still signed in.
    await guardedRpc(supabase, "neo_production_display_manage", { _close: data.session_id });
    throw error;
  }
  // Full navigation discards authenticated React/Query caches in this tab.
  window.location.replace("/station-screen");
}

/** Shared screens never retain an authenticated operator browser session. */
export async function ensureSharedScreenSignedOut() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (data.session) {
    const result = await supabase.auth.signOut({ scope: "local" });
    if (result.error)
      throw new Error("Sign out of the staff account before using this shared screen.");
  }
}
