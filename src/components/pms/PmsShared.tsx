import type { ReactNode } from "react";
import { StatusPill } from "@/components/common/DataDisplay";
import {
  LoadingState,
  NotAuthorisedState,
  NotConfiguredState,
} from "@/components/common/StateSystem";
import { useAuth } from "@/lib/auth";
import { roomConditionTone, reservationStatusTone, folioStatusTone, titleCase } from "@/lib/pms";

/** Gate a whole PMS screen on a `pms` permission. */
export function PmsGuard({ action, children }: { action: string; children: ReactNode }) {
  const { can, loading } = useAuth();
  if (loading) return <LoadingState variant="cards" rows={4} />;
  if (!can("pms", action)) {
    return (
      <NotAuthorisedState
        subject="this Front Office screen"
        detail={`The pms.${action} permission is required. Ask an administrator to grant it from Roles & Permissions.`}
      />
    );
  }
  return <>{children}</>;
}

/**
 * PMS keeps its historic export names, but the implementation is now the one
 * shared NEØ state language in `@/components/common/StateSystem`. Every module
 * shell re-exports these, so the whole staff app inherits the same loading,
 * empty, error, setup and denied presentation.
 */
export {
  EmptyState,
  QueryState,
  ErrorState,
  LoadingState,
  StateCard,
  NotConfiguredState,
  NotAuthorisedState,
  OfflineState,
  sanitizeErrorMessage,
} from "@/components/common/StateSystem";

export function RoomConditionBadge({ condition }: { condition: string }) {
  return <StatusPill tone={roomConditionTone(condition)}>{titleCase(condition)}</StatusPill>;
}

export function ReservationStatusBadge({ status }: { status: string }) {
  return <StatusPill tone={reservationStatusTone(status)}>{titleCase(status)}</StatusPill>;
}

export function FolioStatusBadge({ status }: { status: string }) {
  return <StatusPill tone={folioStatusTone(status)}>{titleCase(status)}</StatusPill>;
}

export function NotConfiguredNotice({ label, steps }: { label: string; steps: string[] }) {
  return (
    <NotConfiguredState
      inline
      feature={label}
      detail="No live connection exists. Nothing is being sent or received, and no data here is simulated."
      action={
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      }
    />
  );
}
