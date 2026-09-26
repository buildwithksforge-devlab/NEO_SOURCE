import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { REAUTH_MESSAGE, requiresReauthentication } from "@/lib/rpc-telemetry";

/**
 * Shown when a screen's data could not be read because the session is missing
 * or no longer authorised. It replaces the misleading empty state ("no riders",
 * "no records") with the one action that actually resolves the failure.
 */
export function SessionExpiredNotice({
  context,
  className,
}: {
  /** What could not be loaded, e.g. "the rider list". */
  context?: string;
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
        Sign in again
      </p>
      <p className="mt-1 text-muted-foreground">
        {context ? `${context} could not be loaded. ` : ""}
        {REAUTH_MESSAGE}
      </p>
      <Button size="sm" className="mt-3" onClick={() => void signOut()}>
        Sign in again
      </Button>
    </div>
  );
}

/** Convenience: render the notice for re-auth failures, otherwise nothing. */
export function ReauthFallback({ error, context }: { error: unknown; context?: string }) {
  if (!requiresReauthentication(error)) return null;
  return <SessionExpiredNotice {...(context ? { context } : {})} />;
}
