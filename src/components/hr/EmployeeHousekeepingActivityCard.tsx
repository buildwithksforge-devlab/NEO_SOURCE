import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  SectionCard,
} from "@/components/common/DataDisplay";

import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { kenyaBusinessDate } from "@/lib/kenya-business-date";

import {
  summarizeHousekeepingActivity,
  type HousekeepingActivityJob,
} from "@/lib/employee-housekeeping-activity";

function nextCalendarDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function EmployeeHousekeepingActivityCard({
  profileId,
}: {
  profileId: string | null | undefined;
}) {
  const { organizationId, user, can } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();

  const permitted = can("housekeeping", "view");

  const period = useMemo(() => {
    const now = new Date();

    return {
      from: kenyaBusinessDate(
        new Date(now.getTime() - 29 * 86_400_000),
      ),
      to: kenyaBusinessDate(now),
    };
  }, []);

  const report = useQuery({
    queryKey: [
      "hr",
      "employee-housekeeping-activity",
      organizationId,
      user?.id,
      filterKey,
      branchId,
      profileId,
      period.from,
      period.to,
    ],

    enabled: Boolean(
      permitted &&
      organizationId &&
      user?.id &&
      profileId,
    ),

    queryFn: async (): Promise<HousekeepingActivityJob[]> => {
      if (!profileId || !organizationId) {
        return [];
      }

      const pageSize = 500;
      const maximumRows = 5000;

      const result: HousekeepingActivityJob[] = [];

      for (let offset = 0; offset < maximumRows; offset += pageSize) {
        let query = supabase
          .from("housekeeping_jobs")
          .select(
            "id, status, inspection_status, completed_at",
          )
          .eq("organization_id", organizationId)
          .eq("assignee_id", profileId)
          .gte(
            "created_at",
            `${period.from}T00:00:00+03:00`,
          )
          .lt(
            "created_at",
            `${nextCalendarDate(period.to)}T00:00:00+03:00`,
          )
          .order("id", { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (branchId) {
          query = query.eq("branch_id", branchId);
        }

        const { data, error } = await query;

        if (error) {
          throw error;
        }

        const page = (data ?? []) as HousekeepingActivityJob[];

        result.push(...page);

        if (page.length < pageSize) {
          return result;
        }
      }

      throw new Error(
        "The housekeeping reporting period exceeds the supported " +
        "record limit. Choose a shorter period; partial totals " +
        "will not be displayed.",
      );
    },
  });

  const summary = useMemo(
    () => summarizeHousekeepingActivity(report.data ?? []),
    [report.data],
  );

  if (!permitted) {
    return null;
  }

  return (
    <SectionCard
      title="Housekeeping Activity"
      description={`Actual housekeeping jobs assigned from ${period.from} to ${period.to}. This is an operational summary, not an employee rating.`}
    >
      {!profileId ? (
        <p className="text-sm text-muted-foreground">
          This employee has no linked system profile.
          Assigned housekeeping activity cannot be matched
          to the HR record.
        </p>
      ) : report.isPending ? (
        <p className="text-sm text-muted-foreground">
          Loading housekeeping activity...
        </p>
      ) : report.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-destructive">
            Housekeeping activity could not be retrieved:{" "}
            {report.error instanceof Error
              ? report.error.message
              : "Unknown reporting error."}
          </p>

          <Button
            size="sm"
            variant="outline"
            onClick={() => void report.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["Jobs assigned", summary.totalAssigned],
              ["Completed jobs", summary.completed],
              ["Awaiting inspection", summary.awaitingInspection],
              ["Currently in rework", summary.reworkJobs],
              [
                "Completed with timestamp",
                summary.completedWithTimestamp,
              ],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className="rounded-lg border p-3"
              >
                <p className="text-xs text-muted-foreground">
                  {label}
                </p>
                <p className="mt-1 text-xl font-semibold">
                  {value}
                </p>
              </div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            Figures describe jobs created and assigned
            during the reporting period. Completion and
            inspection counts reflect their current recorded
            statuses, not necessarily the dates on which
            those actions occurred.
          </p>
        </div>
      )}
    </SectionCard>
  );
}
