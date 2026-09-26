import type { ReactNode } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth";
import { capabilityForPath, pathPermitted } from "@/lib/capabilities";
import { moduleLabels } from "@/lib/permissions";
import { AccessDeniedPanel } from "@/components/common/AccessState";

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

  // The workspace boot gate guarantees effective access is already resolved
  // here, so an empty grant set is a real refusal — not a loading state — and
  // a suspended or unassigned account cannot slip past this gate. There is no
  // administrator exemption: administrative authority is a granted permission.
  if (!permissionsLoaded || capability === null || module === null) return <>{children}</>;
  if (pathPermitted(can, pathname)) return <>{children}</>;

  return (
    <AccessDeniedPanel
      subject={moduleLabels[module] ?? module}
      detail={`Requested path: ${pathname}`}
    />
  );
}

