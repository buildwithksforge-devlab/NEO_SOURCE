import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { HrGuard, QueryState } from "@/components/hr/HrShared";
import { HrSettingsForm, HrSettingsInitialise } from "@/components/hr/HrSettingsForm";
import { PublicHolidaysCard } from "@/components/hr/PublicHolidaysCard";
import { PositionGradesCard } from "@/components/hr/PositionGradesCard";
import { Button } from "@/components/ui/button";
import { useHrSettings, useLeaveTypes } from "@/lib/hr-data";
import { HR_MODULES, type Row } from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/settings")({
  head: () => ({
    meta: [
      { title: "HR Settings — HOS Human Resources" },
      {
        name: "description",
        content: "Attendance rules, leave year, privacy and payroll integration configuration.",
      },
      { property: "og:title", content: "HR Settings — HOS Human Resources" },
      {
        property: "og:description",
        content: "Attendance rules, leave year, privacy and payroll integration configuration.",
      },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.attendance} action="configure">
      <HrSettingsScreen />
    </HrGuard>
  ),
});

function HrSettingsScreen() {
  const settings = useHrSettings();
  const types = useLeaveTypes();
  const s = settings.data as Row | null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="HR Settings"
        description="Attendance tolerance, leave year, document retention and payroll integration for this organization."
      />

      <QueryState
        isLoading={settings.isLoading}
        error={settings.error}
        isEmpty={!s}
        empty={<HrSettingsInitialise />}
      >
        {s ? <HrSettingsForm settings={s} /> : null}
      </QueryState>

      <SectionCard
        title="Leave policies"
        description="Entitlement, accrual, eligibility, carry-forward, weekend and holiday counting, notice and approval route are configured per leave type."
      >
        <p className="mb-3 text-sm text-muted-foreground">
          {(types.data ?? []).length} leave{" "}
          {(types.data ?? []).length === 1 ? "policy" : "policies"} configured. Balances recalculate
          automatically from these rules and each person's joining date.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link to="/hr/leave">Open leave policies</Link>
        </Button>
      </SectionCard>

      <PositionGradesCard />

      <PublicHolidaysCard />
    </div>
  );
}
