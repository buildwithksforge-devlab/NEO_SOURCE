import { RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { REAUTH_MESSAGE, requiresReauthentication } from "@/lib/rpc-telemetry";

/**
 * Shown when a screen could not read its data because the routine access check
 * failed (no session, or the session is no longer authorised).
 *
 * It always offers the next action rather than an empty list: "Try again"
 * re-dispatches the same server-side routine through the guarded path, and
 * "Sign in again" is offered when only a fresh session can resolve it.
 */
export function RpcAccessNotice({
  context,
  onRetry,
  retrying,
  className,
}: {
  /** What could not be loaded, e.g. "the rider list". */
  context?: string;
  /** Re-runs the same guarded server-side call. */
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  const { signOut } = useAuth();
  return (
    <div
      role="alert"
      className={`rounded-lg border border-border/70 bg-muted/30 p-4 text-sm ${className ?? ""}`}
    >
      <p className="flex items-center gap-2 font-medium text-foreground">
        <ShieldAlert className="size-4 text-primary" />
        {context ? `${context} could not be loaded` : "This could not be loaded"}
      </p>
      <p className="mt-1 text-muted-foreground">
        {REAUTH_MESSAGE} If you have just signed in, try again first — the request is re-sent to the
        server, not answered from this browser.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {onRetry ? (
          <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying ?? false}>
            <RefreshCw className={`size-4 ${retrying ? "animate-spin" : ""}`} />
            {retrying ? "Retrying…" : "Try again"}
          </Button>
        ) : null}
        <Button size="sm" onClick={() => void signOut()}>
          Sign in again
        </Button>
      </div>
    </div>
  );
}

/** Renders the notice only for access failures, otherwise nothing. */
export function RpcAccessFallback({
  error,
  context,
  onRetry,
  retrying,
}: {
  error: unknown;
  context?: string;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  if (!requiresReauthentication(error)) return null;
  return (
    <RpcAccessNotice
      {...(context ? { context } : {})}
      {...(onRetry ? { onRetry } : {})}
      {...(retrying === undefined ? {} : { retrying })}
    />
  );
}
