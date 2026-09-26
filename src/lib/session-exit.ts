/**
 * CANONICAL SESSION EXIT.
 *
 * Every entrance — Discover, Guest, Work, Partner, Rider — leaves a session
 * the same way. Before this module each app rolled its own sign-out and the
 * hygiene differed: some cleared the workspace, none cancelled in-flight
 * authenticated queries, and some left the previous person's cached data
 * reachable through browser Back on a shared hotel terminal.
 *
 * Order matters and is not negotiable:
 *   1. cancel in-flight queries, so nothing lands after the session is gone
 *   2. clear the private cache, so Back cannot rehydrate another identity
 *   3. forget the remembered context (kind + property)
 *   4. end the Supabase session
 *   5. replace history, so the protected route is not on the back stack
 *
 * Switching account is the same teardown followed by a fresh authentication;
 * NEØ never holds several silently active sessions in the frontend.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { forgetContext } from "@/lib/continue-context";

export type SessionExitOptions = {
  /** Where the person lands afterwards. Public surfaces only. */
  to?: string;
  /** Switching identity rather than leaving: land on sign-in. */
  reauthenticate?: boolean;
};

/** Tear the session down completely, then navigate to a public surface. */
export async function neoSignOut(
  queryClient: QueryClient | null,
  options: SessionExitOptions = {},
): Promise<void> {
  const destination = options.to ?? (options.reauthenticate ? "/auth" : "/");

  if (queryClient) {
    await queryClient.cancelQueries().catch(() => undefined);
    queryClient.clear();
  }
  forgetContext();
  try {
    await supabase.auth.signOut();
  } catch {
    /* A failed network sign-out must still clear this device. */
  }
  try {
    // A full document replace guarantees no component keeps a stale
    // subscription, realtime channel or memoised identity alive.
    window.location.replace(destination);
  } catch {
    /* Non-browser environment (tests / SSR): navigation is the caller's. */
  }
}

/** Hook form for components: clears this router's cache too. */
export function useNeoSignOut() {
  const queryClient = useQueryClient();
  return useCallback(
    (options?: SessionExitOptions) => neoSignOut(queryClient, options),
    [queryClient],
  );
}

/**
 * Switch account: the same teardown, then the canonical sign-in screen.
 * Never a second concurrent session.
 */
export function useNeoSwitchAccount() {
  const signOut = useNeoSignOut();
  return useCallback(
    (signInRoute = "/auth") => signOut({ to: signInRoute, reauthenticate: true }),
    [signOut],
  );
}
