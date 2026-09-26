import type { ReactNode } from "react";
import { StatusPill } from "@/components/common/DataDisplay";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { securityTone, severityTone } from "@/lib/security-department";
import { titleCase } from "@/lib/kitchen";

export { EmptyState, QueryState } from "@/components/pms/PmsShared";

/** Gate a Security screen on a security feature capability. */
export function SecurityGuard({
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
  if (!can("security-ops", feature, action)) {
    return (
      <AccessDeniedPanel
        subject="this Security screen"
        detail={`Required capability: security.${feature}.${action}`}
      />
    );
  }
  return <>{children}</>;
}

export function SecurityStatusBadge({ status }: { status: string }) {
  return <StatusPill tone={securityTone(status)}>{titleCase(status)}</StatusPill>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <StatusPill tone={severityTone(severity)}>{titleCase(severity)}</StatusPill>;
}

export function WhenLabel({ value, prefix = "Due" }: { value?: string | null; prefix?: string }) {
  if (!value) return <span className="text-xs text-muted-foreground">No time set</span>;
  const at = new Date(value);
  const late = prefix === "Due" && at.getTime() < Date.now();
  return (
    <span className={late ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>
      {prefix} {at.toLocaleString()}
    </span>
  );
}
