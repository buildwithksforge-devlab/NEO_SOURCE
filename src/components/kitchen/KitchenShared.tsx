import type { ReactNode } from "react";
import { StatusPill } from "@/components/common/DataDisplay";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { minutesSince, ticketStatusTone, timerLabel, timerState, timerTone, titleCase } from "@/lib/kitchen";

export { EmptyState, QueryState } from "@/components/pms/PmsShared";

/** Gate a kitchen screen on a `kitchen` permission — same wording as every other refusal. */
export function KitchenGuard({ action, children }: { action: string; children: ReactNode }) {
  const { can, loading } = useAuth();
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!can("kitchen", action)) {
    return <AccessDeniedPanel subject="this kitchen screen" detail={`Required capability: kitchen.${action}`} />;
  }
  return <>{children}</>;
}

export function TicketStatusBadge({ status }: { status: string }) {
  return <StatusPill tone={ticketStatusTone(status)}>{titleCase(status)}</StatusPill>;
}

export function PrepTimer({ startedAt, target }: { startedAt?: string | null; target: number }) {
  const elapsed = minutesSince(startedAt);
  const state = timerState(elapsed, target);
  return (
    <StatusPill tone={timerTone(state)}>
      {elapsed}m / {target}m · {timerLabel(state)}
    </StatusPill>
  );
}

export function AllergyBanner({ allergy, dietary }: { allergy?: string | null; dietary?: string | null }) {
  if (!allergy && !dietary) return null;
  return (
    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-xs font-medium">
      {allergy ? <p>Allergy alert: {allergy}</p> : null}
      {dietary ? <p className="text-muted-foreground">Dietary: {dietary}</p> : null}
    </div>
  );
}
