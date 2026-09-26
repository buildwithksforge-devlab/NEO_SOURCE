import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Lock, PlugZap } from "lucide-react";
import { StatusPill } from "@/components/common/DataDisplay";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { canAccessPath } from "@/lib/nav-permissions";
import { itemStatusTone, orderStatusTone, tableStatusTone, titleCase } from "@/lib/pos";

export { EmptyState, QueryState } from "@/components/pms/PmsShared";

/**
 * Gate a POS screen. When a `path` is given the guard resolves the *same*
 * canonical capability the sidebar link, the POS tab strip and the backend
 * policy resolve, so a screen is never offered to a user who cannot open it.
 *
 * `access` is the module's front door, not a feature of its own. No role
 * template grants a `pos.access` action, so asking for it literally locked
 * every waiter out of the terminal they are staffed on. The front door
 * resolves through the same path capability the sidebar uses instead.
 */
export function PosGuard({
  action,
  path,
  children,
}: {
  action: string;
  path?: string;
  children: ReactNode;
}) {
  const { can, loading } = useAuth();
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  const resolvedPath = path ?? (action === "access" ? "/pos" : undefined);
  const permitted = resolvedPath ? canAccessPath(can, resolvedPath) : can("pos", action);
  if (!permitted) {

    return (
      <Card className="surface-panel">
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <span className="rounded-full bg-muted p-3 text-muted-foreground">
            <Lock className="size-5" />
          </span>
          <p className="text-base font-semibold">You do not have access to this POS screen</p>
          <p className="max-w-md text-sm text-muted-foreground">
            The <span className="font-mono text-xs">pos.{action}</span> permission is required. Ask an
            administrator to grant it from Roles &amp; Permissions.
          </p>
          <Link to="/workspace" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Back to dashboard
          </Link>
        </CardContent>
      </Card>
    );
  }
  return <>{children}</>;
}

export function OrderStatusBadge({ status }: { status: string }) {
  return <StatusPill tone={orderStatusTone(status)}>{titleCase(status)}</StatusPill>;
}

export function ItemStatusBadge({ status }: { status: string }) {
  return <StatusPill tone={itemStatusTone(status)}>{titleCase(status)}</StatusPill>;
}

export function TableStatusBadge({ status }: { status: string }) {
  return <StatusPill tone={tableStatusTone(status)}>{titleCase(status)}</StatusPill>;
}

/** Truthful status card for an integration that has not been connected yet. */
export function IntegrationStatus({
  label,
  status,
  detail,
  steps,
}: {
  label: string;
  status: "connected" | "not-configured" | "offline" | "error";
  detail: string;
  steps?: string[];
}) {
  const tone = status === "connected" ? "success" : status === "not-configured" ? "warning" : "destructive";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PlugZap className="size-4 text-muted-foreground" />
          <p className="text-sm font-semibold">{label}</p>
        </div>
        <StatusPill tone={tone}>{titleCase(status)}</StatusPill>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      {steps?.length ? (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
