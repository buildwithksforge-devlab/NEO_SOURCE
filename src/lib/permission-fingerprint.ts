/**
 * Shared permission fingerprint.
 *
 * `my_permission_version()` is the cheap authority fingerprint used in two
 * places on every page load: the cached effective-access revalidation and the
 * live-session change check. Both used to dispatch their own call within the
 * same second, so every screen paid for the fingerprint twice.
 *
 * This is a de-duplication only — never a relaxation. The window is
 * deliberately short (a few seconds), concurrent callers share one in-flight
 * request, and the value is dropped outright whenever authority may have
 * changed (sign-in, sign-out, workspace switch, permission refresh).
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { supabase } from "@/integrations/supabase/client";

/** How long one fingerprint answer may be shared between callers. */
const SHARE_WINDOW_MS = 5_000;

type Cached = { value: string | null; at: number };

let cached: Cached | null = null;
let inflight: Promise<{ value: string | null; error: unknown }> | null = null;

/** Discards the shared answer; called whenever authority may have changed. */
export function resetPermissionFingerprint() {
  cached = null;
  inflight = null;
}

/**
 * Reads the current permission fingerprint, sharing one request between
 * callers that ask within the same few seconds.
 */
export async function readPermissionFingerprint(): Promise<{
  value: string | null;
  error: unknown;
}> {
  if (cached && Date.now() - cached.at < SHARE_WINDOW_MS) {
    return { value: cached.value, error: null };
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const { data, error } = await guardedRpc(supabase, "my_permission_version");
    if (!error) cached = { value: (data as string | null) ?? null, at: Date.now() };
    return { value: (data as string | null) ?? null, error: error ?? null };
  })().finally(() => {
    inflight = null;
  });

  return inflight;
}
