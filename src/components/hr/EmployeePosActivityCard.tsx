import { kenyaBusinessDate } from "@/lib/kenya-business-date";
import { useMemo } from "react";
import { Link } from "@tanstack/react-router";

import {
  SectionCard,
} from "@/components/common/DataDisplay";

import { Button } from "@/components/ui/button";

import {
  useTeamPosPerformance,
} from "@/lib/pos-data";

import {
  employeePosActivity,
} from "@/lib/employee-pos-activity";

import {
  posReportingErrorMessage,
} from "@/lib/pos-reporting-errors";

import { money } from "@/lib/pos";


export function EmployeePosActivityCard({
  profileId,
}: {
  profileId: string | null | undefined;
}) {
  const period = useMemo(() => {
    const now = new Date();

    return {
      from: kenyaBusinessDate(
        new Date(now.getTime() - 29 * 86_400_000),
      ),
      to: kenyaBusinessDate(now),
    };
  }, []);

  return (
    <EmployeePosActivityContent
      profileId={profileId}
      from={period.from}
      to={period.to}
    />
  );
}

function EmployeePosActivityContent({
  profileId,
  from,
  to,
}: {
  profileId: string | null | undefined;
  from: string;
  to: string;
}) {
  // Hook invocation remains unconditional.
  // Database reporting access stays authoritative.
  const report = useTeamPosPerformance(from, to);

  const activity = employeePosActivity(
    report.data ?? [],
    profileId,
  );

  return (
    <SectionCard
      title="Operational POS Activity"
      description={`Employee-attributed activity from ${from} to ${to}. This is not Finance-certified revenue or a payroll performance rating.`}
    >
      {!profileId ? (
        <p className="text-sm text-muted-foreground">
          This employee does not have a linked system
          profile. POS activity cannot yet be attributed
          to their HR record.
        </p>
      ) : report.isPending ? (
        <p className="text-sm text-muted-foreground">
          Retrieving authorized employee POS activity...
        </p>
      ) : report.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-destructive">
            {posReportingErrorMessage(report.error)}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void report.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : !activity ? (
        <p className="text-sm text-muted-foreground">
          No qualifying POS activity was returned for
          this employee and reporting period.
        </p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[
              ["Orders created", activity.ordersCreated],
              ["Currently assigned", activity.currentlyAssigned],
              ["Finalized orders", activity.finalized],
              ["Cancelled orders", activity.cancelled],
              ["Voided orders", activity.voided],
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

            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">
                Finalized bill value
              </p>
              <p className="mt-1 text-xl font-semibold">
                {money(activity.finalizedBillValue)}
              </p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Values follow the original POS reporting
            attribution rules. Assignments and order
            creation are different measures. Financial
            reconciliation remains separate.
          </p>
        </div>
      )}

      <div className="mt-4">
        <Button asChild size="sm" variant="outline">
          <Link to="/pos/reports">
            Open POS reports
          </Link>
        </Button>
      </div>
    </SectionCard>
  );
}
