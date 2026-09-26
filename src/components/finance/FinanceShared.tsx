import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Lock, Wallet } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/common/DataDisplay";
import { useAuth } from "@/lib/auth";
import { statusTone, titleCase } from "@/lib/finance";

export { DataTable, FormDialog, RecordForm, NotConfigured } from "@/components/events/EventsShared";
export type { FieldSpec } from "@/components/events/EventsShared";
export { EventsQueryState as FinanceQueryState } from "@/components/events/EventsShared";

/**
 * Gate a finance screen on the capability that screen actually needs.
 *
 * Feature-level on purpose: accounts payable, the general ledger, journals,
 * reconciliation and period close are separate responsibilities, and holding
 * one has never meant holding the rest. There is no blanket "finance" fallback
 * here — that shortcut is exactly what let broad visibility masquerade as broad
 * authority. Backend policies enforce the same rule.
 */
export function FinanceGuard({
  module = "finance",
  feature = "*",
  action = "view",
  children,
}: {
  module?: string;
  feature?: string;
  action?: string;
  children: ReactNode;
}) {
  const { can, loading, isAdmin } = useAuth();
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!isAdmin && !can(module, feature, action)) {
    return (
      <Card className="surface-panel">
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <span className="rounded-full bg-muted p-3 text-muted-foreground">
            <Lock className="size-5" />
          </span>
          <p className="text-base font-semibold">You do not have access to this Finance screen</p>
          <p className="max-w-md text-sm text-muted-foreground">
            The <span className="font-mono text-xs">{module}.{feature}.{action}</span> permission is required. Ask an
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


export function FinanceEmpty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/70 px-6 py-12 text-center">
      <span className="rounded-full bg-muted p-3 text-muted-foreground">
        <Wallet className="size-5" />
      </span>
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      {action}
    </div>
  );
}

export function FinStatus({ value }: { value: string }) {
  return <StatusPill tone={statusTone(value)}>{titleCase(value)}</StatusPill>;
}

/** Standard head metadata factory for finance leaf routes. */
export function financeHead(title: string, description: string) {
  return () => ({
    meta: [
      { title: `${title} — NEØ` },
      { name: "description", content: description },
      { property: "og:title", content: `${title} — NEØ` },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  });
}
