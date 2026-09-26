import type { ReactNode } from "react";
import { StatusPill } from "@/components/common/DataDisplay";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { pastryTone } from "@/lib/pastry-department";
import { titleCase } from "@/lib/kitchen";

export { EmptyState, QueryState } from "@/components/pms/PmsShared";

/** Gate a pastry screen on a kitchen feature capability. */
export function PastryGuard({
  feature,
  action = "view",
  children,
}: {
  feature: string;
  action?: string;
  children: ReactNode;
}) {
  const { can, loading } = useAuth();
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!can("kitchen", feature, action)) {
    return (
      <AccessDeniedPanel
        subject="this Pastry & Bakery screen"
        detail={`Required capability: kitchen.${feature}.${action}`}
      />
    );
  }
  return <>{children}</>;
}

export function PastryStatusBadge({ status }: { status: string }) {
  return <StatusPill tone={pastryTone(status)}>{titleCase(status)}</StatusPill>;
}

export function DueLabel({ value }: { value?: string | null }) {
  if (!value) return <span className="text-xs text-muted-foreground">No due time</span>;
  const due = new Date(value);
  const late = due.getTime() < Date.now();
  return (
    <span className={late ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
      Due {due.toLocaleString()}
    </span>
  );
}
