import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Lock, Sparkles } from "lucide-react";
import { StatusPill } from "@/components/common/DataDisplay";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { capabilitiesForPath, pathPermitted } from "@/lib/capabilities";
import { titleCase, type OpsInsight, type Tone } from "@/lib/operations";

export { EmptyState, QueryState } from "@/components/pms/PmsShared";

/**
 * Gate an operations screen. Owners/administrators pass.
 *
 * Prefer the `path` form: it asks the shared capability registry the very same
 * question the sidebar asks, so a screen the navigation offers can never deny
 * the person who clicks it. The `module`/`action` form remains for screens
 * that are not a whole route.
 */
export function OpsGuard({
  module,
  action = "view",
  path,
  children,
}: {
  module?: string;
  action?: string;
  path?: string;
  children: ReactNode;
}) {
  const { can, canModule, loading } = useAuth();
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  // A bare `module` names the workspace front door, not a feature: anyone who
  // holds that action on any feature of the module may open it (each inner
  // surface still asks its own capability). A dotted action stays exact.
  const allowed = path
    ? pathPermitted(can, path)
    : action.includes(".")
      ? can(module ?? "", action)
      : canModule(module ?? "", action);
  if (!allowed) {
    const required = path
      ? (capabilitiesForPath(path)
          .map((c) => `${c.module}.${c.feature}.${c.action}`)
          .join(" or ") || path)
      : `${module}.${action}`;
    return (
      <Card className="surface-panel">
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <span className="rounded-full bg-muted p-3 text-muted-foreground">
            <Lock className="size-5" />
          </span>
          <p className="text-base font-semibold">You do not have access to this screen</p>
          <p className="max-w-md text-sm text-muted-foreground">
            The <span className="font-mono text-xs">{required}</span> permission is required. Ask an
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


export function OpsBadge({ value, tone }: { value: unknown; tone: Tone }) {
  return <StatusPill tone={tone}>{titleCase(value)}</StatusPill>;
}

/** Advisory-only AI panel. Shows a "Not Configured" note when no provider is connected. */
export function OpsAssistant({
  insights,
  configured = true,
}: {
  insights: OpsInsight[];
  configured?: boolean;
}) {
  return (
    <Card className="surface-panel">
      <CardContent className="space-y-3 py-5">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-primary-soft p-2 text-primary">
            <Sparkles className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold">AI Operations Assistant</p>
            <p className="text-xs text-muted-foreground">
              Advisory only — it never releases rooms, approves requisitions or moves stock.
            </p>
          </div>
        </div>
        {!configured ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            AI Operations Assistant — Not Configured
          </p>
        ) : (
          <ul className="space-y-2">
            {insights.map((insight) => (
              <li key={insight.title} className="rounded-lg border border-border/70 p-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium">{insight.title}</p>
                  <StatusPill tone={insight.tone}>Advisory</StatusPill>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{insight.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

/** Shown where an external provider (dry cleaning, IoT, SMS) has no credentials. */
export function NotConfigured({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      {label} — Not Configured
    </div>
  );
}
