import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, TriangleAlert, UserCog } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { prefetchWorkspaceData } from "@/lib/boot-prefetch";
import { perfMark } from "@/lib/access-cache";
import { WorkspaceShellSkeleton } from "@/components/common/ShellSkeleton";

/**
 * Stage 1 — atomic authentication bootstrap.
 *
 * The protected workspace is not mounted until the backend has confirmed the
 * account, tenant, property, department, station, roles and effective
 * permissions. That prevents the previous account's dashboard, tenant or
 * records from being shown for even one frame, and prevents a transient
 * "No role assigned" or "All properties" state while a valid assignment is
 * still loading. Every non-ready state is stated truthfully.
 */
function BootPanel({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          {icon}
        </div>
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        {children}
      </div>
    </div>
  );
}

export function WorkspaceBootGate({ children }: { children: ReactNode }) {
  const {
    phase,
    phaseDetail,
    isAdmin,
    access,
    accessLoaded,
    canRecoverWorkspace,
    recoverWorkspace,
    signOut,
    organizationId,
  } = useAuth();
  const queryClient = useQueryClient();
  const [recovering, setRecovering] = useState(false);

  /**
   * Once access is confirmed, warm the shared workspace queries while the
   * browser is idle. Nothing is granted or invented here — every prefetch is
   * the same RLS-checked read the screen would make on entry.
   */
  const ready = phase === "ready" && access.accountType === "staff";
  const branchId = access.branchIds.length === 1 ? (access.branchIds[0] ?? null) : null;
  useEffect(() => {
    if (!ready) return;
    perfMark("workspace-ready");
    return prefetchWorkspaceData(queryClient, { organizationId, branchId });
  }, [ready, queryClient, organizationId, branchId]);

  /**
   * Stage 1 — staff / customer separation. A guest (customer) account never
   * mounts the staff workspace, whatever the URL says: the account type comes
   * from the backend access contract, not from the route or a role name.
   */
  if (accessLoaded && access.accountType && access.accountType !== "staff") {
    return (
      <BootPanel
        icon={<ShieldAlert className="size-6" />}
        title="Guest account"
        description="This sign-in is a guest account, so it cannot open the staff workspace. Use your hotel's guest portal to view your stay, requests and bills."
      >
        <Button variant="outline" className="mt-6" onClick={() => void signOut()}>
          Sign out
        </Button>
      </BootPanel>
    );
  }

  if (phase === "ready") return <>{children}</>;

  if (phase === "setup-incomplete" && isAdmin) return <>{children}</>;

  if (phase === "suspended" || phase === "denied") {
    return (
      <BootPanel
        icon={<ShieldAlert className="size-6" />}
        title={phase === "suspended" ? "Account not active" : "Access not permitted"}
        description={
          phaseDetail ??
          "This sign-in cannot open a workspace. Contact your administrator to restore access."
        }
      >
        <Button variant="outline" className="mt-6" onClick={() => void signOut()}>
          Sign out
        </Button>
      </BootPanel>
    );
  }

  if (phase === "setup-incomplete") {
    return (
      <BootPanel
        icon={<UserCog className="size-6" />}
        title={canRecoverWorkspace ? "Resume workspace setup" : "Account setup required"}
        description={
          canRecoverWorkspace
            ? (phaseDetail ?? "Your Owner workspace setup was interrupted and can be resumed safely.")
            : (phaseDetail ?? "Your account has no complete workplace assignment. An administrator must complete it.")
        }
      >
        <div className="mt-6 flex justify-center gap-2">
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
          {canRecoverWorkspace ? (
            <Button
              disabled={recovering}
              onClick={() => {
                setRecovering(true);
                void recoverWorkspace().catch(() => undefined).finally(() => setRecovering(false));
              }}
            >
              {recovering ? "Resuming…" : "Resume workspace setup"}
            </Button>
          ) : (
            <Button asChild variant="ghost">
              <Link to="/workspace">Retry</Link>
            </Button>
          )}
        </div>
      </BootPanel>
    );
  }

  if (phase === "reauth-required") {
    return (
      <BootPanel
        icon={<ShieldAlert className="size-6" />}
        title="Sign in again"
        description={
          phaseDetail ??
          "Your session is no longer authorised, so your permissions could not be read. Sign in again to continue — no data is shown until access is confirmed."
        }
      >
        <Button className="mt-6" onClick={() => void signOut()}>
          Sign in again
        </Button>
      </BootPanel>
    );
  }

  if (phase === "error") {
    return (
      <BootPanel
        icon={<TriangleAlert className="size-6" />}
        title="Access could not be confirmed"
        description={
          phaseDetail ??
          "The system could not confirm your permissions. This is a recoverable error — no data is shown until access is confirmed."
        }
      >
        <Button className="mt-6" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </BootPanel>
    );
  }

  const label =
    phase === "authenticating"
      ? "Signing you in"
      : phase === "resolving-account"
        ? "Resolving your account and organisation"
        : phase === "resolving-access"
          ? "Resolving properties, departments, roles and permissions"
          : "Preparing your workspace";

  // Layout-stable boot: the workspace frame is drawn immediately so the shell
  // never re-lays out (shakes) when the real navigation and cards arrive.
  return <WorkspaceShellSkeleton label={`${label}…`} />;
}
