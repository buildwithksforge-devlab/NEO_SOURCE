import { useMemo } from "react";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import {
  resolveVisibility,
  type VisibilityContract,
  type VisibilityFacts,
} from "@/lib/visibility-contract";

/**
 * Stored reporting relationships for the signed-in user.
 *
 * Managerial visibility needs a real relationship record, never a job title:
 * a manager only sees a subordinate's work when the subordinate reports to
 * them AND falls inside their permitted property / department / station scope
 * (the scope test lives in the contract itself).
 */
function useReportingFacts(profileId: string | null) {
  const { applyTo, branchId, filterKey } = useActivePropertyFilter();
  return useQuery({
    queryKey: ["visibility-subordinates", profileId, filterKey],
    enabled: Boolean(profileId),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const empty = { subordinates: [] as string[], reportingManagerId: null as string | null };
      // One round trip, not two: the direct reports are read through the
      // self-referencing relationship in the same request. The previous
      // manager-then-reports waterfall cost every screen an extra sequential
      // request before the visibility contract could resolve. The selected
      // property still narrows the reports exactly as the second request did.
      const me = await applyTo(
        supabase
          .from("employees")
          .select(
            // The self-relationship is named by its column, not its constraint:
            // the constraint-name hint is rejected for self-joins and made every
            // staff screen fire a failing request.
            "id, reporting_manager_id, reports:employees!reporting_manager_id(profile_id, branch_id)",
          ),
        "employees",
      )
        .eq("profile_id", profileId!)
        .maybeSingle();
      if (me.error || !me.data) return empty;
      const record = me.data as unknown as {
        id: string;
        reporting_manager_id: string | null;
        reports: { profile_id: string | null; branch_id: string | null }[] | null;
      };
      return {
        reportingManagerId: record.reporting_manager_id ?? null,
        subordinates: (record.reports ?? [])
          .filter((r) => !branchId || r.branch_id === branchId)
          .map((r) => r.profile_id)
          .filter((id): id is string => Boolean(id)),
      };
    },
  });
}

/**
 * The one visibility contract every screen should ask.
 *
 * Pages, actions, records, approvals, tasks, notifications, reports, cost
 * figures and selectors all resolve from the same facts, so a custom role
 * created in Administration behaves correctly with no code change.
 */
export function useVisibility(): VisibilityContract {
  const auth = useAuth();
  const { profile, permissions, permissionsLoaded, organizationId } = auth;
  // Tolerate a partially hydrated session: an absent access record simply
  // means no scope yet, never a crashed shell.
  const access = auth.access ?? ({} as (typeof auth)["access"]);
  const reporting = useReportingFacts(profile?.id ?? null);

  return useMemo(() => {
    const facts: VisibilityFacts = {
      userId: profile?.id ?? null,
      accountType: access.accountType,
      accountStatus: access.accountStatus ?? profile?.account_status ?? null,
      organizationId: organizationId ?? profile?.organization_id ?? null,
      accessScope: access.accessScope,
      branchIds: access.branchIds ?? [],
      departmentIds: access.departmentIds ?? [],
      stationIds: access.stationIds ?? [],
      grants: permissionsLoaded ? permissions : new Set<string>(),
      entitlements: access.entitlements ?? {},
      setupComplete: access.setupComplete,
      subordinateUserIds: reporting.data?.subordinates ?? [],
      roleNames: auth.roleNames ?? [],
      reportingManagerId: reporting.data?.reportingManagerId ?? null,
    };
    return resolveVisibility(facts);
  }, [profile, permissions, permissionsLoaded, access, organizationId, reporting.data, auth.roleNames]);
}
