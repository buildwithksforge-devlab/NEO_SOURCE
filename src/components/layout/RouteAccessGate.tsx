import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { capabilityForPath, isUniversalRoute, pathPermitted } from "@/lib/capabilities";
import { moduleLabels } from "@/lib/permissions";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { LoadingState } from "@/components/common/StateSystem";

/**
 * Stage 8 — direct URL protection.
 *
 * Hiding a sidebar entry is presentation only: a user can still type the path.
 * This gate applies the *same* resolver the sidebar, the tab strips and the
 * in-page guards apply (`pathPermitted`), so a page can never be offered and
 * then refused — the defect that showed housekeepers, maintenance officers and
 * riders their assigned work and then denied them the workspace holding it.
 * The backend remains the real authority — RLS still refuses the queries.
 */
export function RouteAccessGate({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { can, permissionsLoaded } = useAuth();

  const capability = capabilityForPath(pathname);
  const module = capability?.module ?? null;

  if (isUniversalRoute(pathname)) return <>{children}</>;
  if (!permissionsLoaded) return <LoadingState rows={3} />;
  if (pathPermitted(can, pathname)) return <>{children}</>;

  return (
    <AccessDeniedPanel
      subject={module ? (moduleLabels[module] ?? module) : "this workspace page"}
      detail={`Requested path: ${pathname}`}
    />
  );
}

