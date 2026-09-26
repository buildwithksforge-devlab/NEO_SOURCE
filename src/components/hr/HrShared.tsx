import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Lock, Sparkles, ShieldAlert } from "lucide-react";
import { StatusPill } from "@/components/common/DataDisplay";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { titleCase, type HrInsight, type Tone } from "@/lib/hr";

export { EmptyState, QueryState } from "@/components/pms/PmsShared";

/** Gate an HR screen behind a permission. Owners and administrators always pass. */
export function HrGuard({
  module,
  action = "view",
  children,
}: {
  module: string;
  action?: string;
  children: ReactNode;
}) {
  const { can, loading } = useAuth();
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!can(module, action)) {
    return (
      <Card className="surface-panel">
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <span className="rounded-full bg-muted p-3 text-muted-foreground">
            <Lock className="size-5" />
          </span>
          <p className="text-base font-semibold">You do not have access to this screen</p>
          <p className="max-w-md text-sm text-muted-foreground">
            The{" "}
            <span className="font-mono text-xs">
              {module}.{action}
            </span>{" "}
            permission is required. Ask an administrator to grant it from Roles &amp; Permissions.
          </p>
          <Link to="/hr" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Back to Human Resources
          </Link>
        </CardContent>
      </Card>
    );
  }
  return <>{children}</>;
}

/** Inline gate for a sensitive block inside an otherwise visible screen. */
export function SensitiveBlock({
  module,
  action,
  label,
  children,
}: {
  module: string;
  action: string;
  label: string;
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!can(module, action)) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-dashed border-border/70 bg-muted/40 p-4 text-sm">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="font-medium text-foreground">{label} is restricted</p>
          <p className="text-muted-foreground">
            This information is only visible to staff holding the{" "}
            <span className="font-mono text-xs">
              {module}.{action}
            </span>{" "}
            permission.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export function HrBadge({ value, tone }: { value: unknown; tone: Tone }) {
  return <StatusPill tone={tone}>{titleCase(value)}</StatusPill>;
}

/** Advisory-only workforce assistant. It never approves, hires, pays or disciplines. */
export function HrAssistant({ insights }: { insights: HrInsight[] }) {
  return (
    <Card className="surface-panel">
      <CardContent className="space-y-3 py-5">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-primary-soft p-2 text-primary">
            <Sparkles className="size-4" />
          </span>
          <div>
            <p className="text-sm font-semibold">AI Workforce Assistant</p>
            <p className="text-xs text-muted-foreground">
              Advisory only — it never approves leave, edits attendance, decides hiring or changes pay.
            </p>
          </div>
        </div>
        <ul className="space-y-2">
          {insights.map((insight) => (
            <li key={insight.title} className="rounded-lg border border-border/70 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{insight.title}</p>
                  <p className="text-xs text-muted-foreground">{insight.detail}</p>
                </div>
                <StatusPill tone={insight.tone}>{titleCase(insight.tone)}</StatusPill>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** Reminder that HR records, guest records and login accounts are separate objects. */
export function IdentitySeparationNotice() {
  return (
    <p className="rounded-lg border border-dashed border-border/70 bg-muted/40 p-3 text-xs text-muted-foreground">
      Employee records are separate from guest/customer profiles and from platform login accounts. Creating an
      employee never creates a login; system access is granted separately and can be revoked without deleting
      the HR record.
    </p>
  );
}
