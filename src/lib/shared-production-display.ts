import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import type { KitchenTicket } from "@/lib/kitchen-tickets";

export const DISPLAY_TOKEN_STORAGE_KEY =
  "neo.production.display.token.v1";
export const DISPLAY_EXPIRY_STORAGE_KEY =
  "neo.production.display.expires.v1";

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

function storageAvailable() {
  return typeof window !== "undefined";
}

export function clearSharedDisplayToken() {
  if (!storageAvailable()) return;

  window.localStorage.removeItem(DISPLAY_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(DISPLAY_EXPIRY_STORAGE_KEY);
}

export function readSharedDisplayToken() {
  if (!storageAvailable()) return "";

  try {
    const token =
      window.localStorage.getItem(DISPLAY_TOKEN_STORAGE_KEY) ?? "";
    const expiresAt =
      window.localStorage.getItem(DISPLAY_EXPIRY_STORAGE_KEY);

    if (!token || token.length > 256) {
      clearSharedDisplayToken();
      return "";
    }

    if (
      expiresAt &&
      (!Number.isFinite(Date.parse(expiresAt)) ||
        Date.parse(expiresAt) <= Date.now())
    ) {
      clearSharedDisplayToken();
      return "";
    }

    return token;
  } catch {
    return "";
  }
}

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

export async function readSharedDisplay(
  token: string,
): Promise<SharedDisplaySnapshot> {
  const { data, error } = await guardedRpc<SharedDisplaySnapshot>(
    supabase,
    "neo_production_display_read",
    { _token: token },
  );

  if (error) throw new Error(error.message);

  if (data?.expires_at && storageAvailable()) {
    window.localStorage.setItem(
      DISPLAY_EXPIRY_STORAGE_KEY,
      data.expires_at,
    );
  }

  return data;
}

export async function actOnSharedDisplay(
  token: string,
  pin: string,
  action: SharedDisplayAction,
): Promise<DisplayActionResult> {
  const { data, error } = await guardedRpc<DisplayActionResult>(
    supabase,
    "neo_production_display_act_pin_only",
    {
      _token: token,
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
  const { data, error } = await guardedRpc<{
    ok: boolean;
    token: string;
    session_id: string;
    expires_at?: string;
  }>(
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

  if (!data?.ok || !data.token || !data.session_id) {
    throw new Error("The paired-display response was incomplete.");
  }

  try {
    // The restricted display credential belongs to this browser, not to the
    // supervisor. localStorage allows the paired station to survive tab and
    // browser restarts; the server expiry and supervisor revocation still win.
    window.localStorage.setItem(
      DISPLAY_TOKEN_STORAGE_KEY,
      data.token,
    );

    if (data.expires_at) {
      window.localStorage.setItem(
        DISPLAY_EXPIRY_STORAGE_KEY,
        data.expires_at,
      );
    } else {
      window.localStorage.removeItem(
        DISPLAY_EXPIRY_STORAGE_KEY,
      );
    }

    if (
      window.localStorage.getItem(DISPLAY_TOKEN_STORAGE_KEY) !==
      data.token
    ) {
      throw new Error(
        "This browser could not retain the paired display session.",
      );
    }

    const result = await supabase.auth.signOut({ scope: "local" });

    if (result.error) throw result.error;
  } catch (pairingError) {
    clearSharedDisplayToken();

    // If sign-out or browser storage failed, close the new display session
    // while the supervisor session is still available.
    await guardedRpc(
      supabase,
      "neo_production_display_manage",
      { _close: data.session_id },
    ).catch(() => undefined);

    throw pairingError;
  }

  window.location.replace("/station-screen");
}

/** Shared screens never retain an authenticated operator browser session. */
export async function ensureSharedScreenSignedOut() {
  const { data, error } = await supabase.auth.getSession();

  if (error) throw error;

  if (data.session) {
    const result = await supabase.auth.signOut({ scope: "local" });

    if (result.error) {
      throw new Error(
        "Sign out of the staff account before using this shared screen.",
      );
    }
  }
}