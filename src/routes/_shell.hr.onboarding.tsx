/**
 * Staff onboarding journey.
 *
 * One screen for the whole path a new colleague travels: an account becomes an
 * employee record with an HR number and card, HR establishes the employment
 * terms, and only then is the person enrolled in payroll. Every outstanding
 * item is a fact a person has to enter — nothing here is invented — so the
 * completion figure moves only as real records are filled in.
 */
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { IdCard, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { EmptyState } from "@/components/pms/PmsShared";
import { OpsGuard } from "@/components/operations/OpsShared";
import { EmploymentTermsDialog } from "@/components/hr/EmploymentTermsCard";
import { PayrollOnboardingDialog } from "@/components/hr/PayrollOnboardingDialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import { useEmployees, usePayrollPeriods } from "@/lib/hr-data";
import { usePositionGrades } from "@/lib/hr-terms";
import { usePayrollEnrolment } from "@/lib/hr-payroll";
import { onboardingProgress, onboardingRollup, onboardingStages } from "@/lib/hr-onboarding";
import type { Row } from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/onboarding")({
  head: () => ({
    meta: [
      { title: "Staff Onboarding — NEØ" },
      {
        name: "description",
        content:
          "Take a new colleague from account to employee record, employment terms and payroll enrolment in one place.",
      },
      { property: "og:title", content: "Staff Onboarding — NEØ" },
      {
        property: "og:description",
        content:
          "Issue HR numbers and staff cards, establish employment terms and enrol staff in payroll.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="human-resources" action="employees.view">
      <StaffOnboardingPage />
    </OpsGuard>
  ),
});

type ProfileRow = {
  id: string;
  full_name: string | null;
  email: string | null;
  job_title: string | null;
  branch_id: string | null;
  department_id: string | null;
  account_status: string | null;
  created_at: string | null;
};

type EmployeeRow = {
  id: string;
  profile_id: string | null;
  employee_number: string | null;
  branch_id: string | null;
};

type CardRow = { employee_id: string; card_number: string; status: string };

function StaffOnboardingPage() {
  const { profile, can } = useAuth();
  const { branches } = useBranchScope();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [termsFor, setTermsFor] = useState<Row | null>(null);
  const [payrollOpen, setPayrollOpen] = useState(false);
  const mayOnboard = can("administration", "users.create") || can("human-resources", "employees.create");

  const org = profile?.organization_id ?? null;

  const roster = useQuery({
    queryKey: ["hr", "onboarding", org ?? "none"],
    enabled: Boolean(org),
    queryFn: async () => {
      const accounts = await supabase
        .from("profiles")
        .select("id, full_name, email, job_title, branch_id, department_id, account_status, created_at")
        .eq("organization_id", org!)
        .eq("account_type", "staff")
        .order("created_at", { ascending: false });
      if (accounts.error) throw new Error(accounts.error.message);

      const employees = await supabase
        .from("employees")
        .select("id, profile_id, employee_number, branch_id")
        .eq("organization_id", org!);
      if (employees.error) throw new Error(employees.error.message);

      const cards = await supabase
        .from("staff_cards")
        .select("employee_id, card_number, status")
        .eq("organization_id", org!);
      if (cards.error) throw new Error(cards.error.message);

      return {
        accounts: (accounts.data ?? []) as ProfileRow[],
        employees: (employees.data ?? []) as EmployeeRow[],
        cards: (cards.data ?? []) as CardRow[],
      };
    },
  });

  /* ---------------- journey data: record → terms → payroll ---------------- */

  const staff = useEmployees({ status: "all" });
  const enrolment = usePayrollEnrolment();
  const grades = usePositionGrades();
  const periods = usePayrollPeriods();
  const activePeriod = ((periods.data ?? []) as Row[]).find(
    (p) => String(p["status"] ?? "") !== "posted" && String(p["status"] ?? "") !== "cancelled",
  );

  const paymentDetails = useQuery({
    queryKey: ["hr", "onboarding", "payment-details", org ?? "none"],
    enabled: Boolean(org),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_payment_details")
        .select("employee_id")
        .eq("organization_id", org!);
      if (error) throw new Error(error.message);
      return new Set((data ?? []).map((r) => String((r as { employee_id: string }).employee_id)));
    },
  });

  const journey = useMemo(() => {
    const payByEmployee = new Map(
      (enrolment.data ?? []).map((p) => [p.employee_id, p.base_amount !== null]),
    );
    const withDetails = paymentDetails.data ?? new Set<string>();
    return ((staff.data ?? []) as Row[])
      .filter((e) => String(e["employment_status"] ?? "") !== "exited")
      .map((e) => {
        const id = String(e["id"]);
        const stages = onboardingStages(e, {
          hasPayRecord: payByEmployee.get(id) === true,
          hasPaymentDetails: withDetails.has(id),
        });
        return { employee: e, stages, progress: onboardingProgress(stages) };
      })
      .sort((a, b) => a.progress.percent - b.progress.percent);
  }, [staff.data, enrolment.data, paymentDetails.data]);

  const rollup = useMemo(() => onboardingRollup(journey), [journey]);
  const outstanding = journey.filter((r) => r.progress.percent < 100);

  const onboard = useMutation({
    mutationFn: async (profileId: string) => {
      const { data, error } = await guardedRpc(supabase, "neo_onboard_staff", {
        _profile: profileId,
        _issue_card: true,
      } as never);
      if (error) throw new Error(error.message);
      return data as { employee_number?: string; card_number?: string } | null;
    },
    onSuccess: (result) => {
      toast.success(
        `Onboarded · HR number ${result?.employee_number ?? "issued"}${
          result?.card_number ? ` · card ${result.card_number}` : ""
        }`,
      );
      void qc.invalidateQueries({ queryKey: ["hr"] });
      void qc.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setBusy(null),
  });

  const data = roster.data;
  const byProfile = new Map((data?.employees ?? []).map((e) => [e.profile_id ?? "", e]));
  const cardFor = new Map((data?.cards ?? []).map((c) => [c.employee_id, c]));
  const pending = (data?.accounts ?? []).filter((a) => {
    const emp = byProfile.get(a.id);
    return !emp || !emp.employee_number || !cardFor.has(emp.id);
  });

  const branchName = (id: string | null) =>
    branches.find((b) => b.id === id)?.name ?? "Not assigned";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Staff Onboarding"
        description="Account to employee record, employment terms, then payroll — in the order HR actually works. Each outstanding item is a fact somebody has to enter; nothing is filled in for you."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Active employees" value={String(rollup.total)} />
        <StatCard label="Fully onboarded" value={String(rollup.complete)} />
        <StatCard label="Awaiting employment terms" value={String(rollup.awaitingTerms)} />
        <StatCard label="Awaiting payroll enrolment" value={String(rollup.awaitingPayroll)} />
      </div>

      <SectionCard
        title="Onboarding journey"
        description="Everyone still travelling the path, least complete first."
        actions={
          <Button size="sm" variant="outline" onClick={() => setPayrollOpen(true)}>
            Put someone on payroll
          </Button>
        }
      >
        <>
          {staff.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading employee records…</p>
          ) : outstanding.length === 0 ? (
            <EmptyState
              icon={UserPlus}
              title="Everyone is fully onboarded"
              description="Employment terms are established and payroll enrolment is complete for every active employee."
            />
          ) : (
            <TableScroll>
<Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead className="w-40">Completion</TableHead>
                  <TableHead>Still outstanding</TableHead>
                  <TableHead className="text-right">Next step</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outstanding.map(({ employee, stages, progress }) => {
                  const next = progress.nextStage;
                  return (
                    <TableRow key={String(employee["id"])}>
                      <TableCell className="font-medium">
                        <Link
                          to="/hr/employees/$id"
                          params={{ id: String(employee["id"]) }}
                          className="hover:underline"
                        >
                          {String(employee["full_name"] ?? "Unnamed")}
                        </Link>
                        <div className="text-xs text-muted-foreground">
                          {[employee["employee_number"], employee["job_title"]]
                            .filter(Boolean)
                            .join(" · ") || "No HR number yet"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Progress value={progress.percent} className="h-2" />
                        <div className="mt-1 text-xs text-muted-foreground">
                          {progress.percent}% · {progress.stagesDone} of {stages.length} stages
                        </div>
                      </TableCell>
                      <TableCell className="text-xs">
                        <div className="flex flex-wrap gap-1.5">
                          {stages.map((s) => (
                            <StatusPill key={s.key} tone={s.done ? "success" : "warning"}>
                              {s.label}
                              {s.done ? "" : ` · ${s.missing.join(", ")}`}
                            </StatusPill>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        {next?.key === "terms" ? (
                          <Button size="sm" variant="outline" onClick={() => setTermsFor(employee)}>
                            Establish terms
                          </Button>
                        ) : next?.key === "payroll" ? (
                          <Button size="sm" variant="outline" onClick={() => setPayrollOpen(true)}>
                            Enrol in payroll
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" asChild>
                            <Link to="/hr/employees/$id" params={{ id: String(employee["id"]) }}>
                              Complete record
                            </Link>
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
</TableScroll>
          )}
        </>
      </SectionCard>

      <SectionCard
        title="Accounts awaiting an HR record"
        description="Accounts with no HR record, no HR number, or no staff card yet."
      >
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <StatCard label="Staff accounts" value={String(data?.accounts.length ?? 0)} />
            <StatCard label="Awaiting onboarding" value={String(pending.length)} />
            <StatCard label="Cards issued" value={String(data?.cards.length ?? 0)} />
          </div>
          {pending.length === 0 ? (
            <EmptyState
              icon={UserPlus}
              title="Every staff account has an HR record"
              description="New accounts created on the Users page will appear here."
            />
          ) : (
            <TableScroll>
<Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Job title</TableHead>
                  <TableHead>Property</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">
                      {row.full_name || "Unnamed"}
                      <div className="text-xs text-muted-foreground">{row.email || "—"}</div>
                    </TableCell>
                    <TableCell>{row.job_title || "Not recorded"}</TableCell>
                    <TableCell>{branchName(row.branch_id)}</TableCell>
                    <TableCell>
                      <StatusPill tone={row.account_status === "active" ? "success" : "warning"}>
                        {row.account_status || "unknown"}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        disabled={!mayOnboard || busy === row.id}
                        onClick={() => {
                          setBusy(row.id);
                          onboard.mutate(row.id);
                        }}
                      >
                        {busy === row.id ? (
                          <Loader2 className="mr-2 size-4 animate-spin" />
                        ) : (
                          <IdCard className="mr-2 size-4" />
                        )}
                        Onboard &amp; issue card
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
</TableScroll>
          )}
        </>
      </SectionCard>

      <SectionCard title="Issued staff cards" description="HR numbers and card numbers on record.">
        <>
          {(data?.cards.length ?? 0) === 0 ? (
            <EmptyState
              icon={IdCard}
              title="No staff card issued yet"
              description="Cards are issued when an account is onboarded."
            />
          ) : (
            <TableScroll>
<Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Card number</TableHead>
                  <TableHead>HR number</TableHead>
                  <TableHead>Property</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.cards ?? []).map((card) => {
                  const emp = (data?.employees ?? []).find((e) => e.id === card.employee_id);
                  return (
                    <TableRow key={card.card_number}>
                      <TableCell className="font-medium">{card.card_number}</TableCell>
                      <TableCell>{emp?.employee_number ?? "—"}</TableCell>
                      <TableCell>{branchName(emp?.branch_id ?? null)}</TableCell>
                      <TableCell>
                        <StatusPill tone="success">{card.status}</StatusPill>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
</TableScroll>
          )}
        </>
      </SectionCard>

      {termsFor ? (
        <EmploymentTermsDialog
          open
          onOpenChange={(next) => !next && setTermsFor(null)}
          employee={termsFor}
          grades={(grades.data ?? []) as Row[]}
        />
      ) : null}

      <PayrollOnboardingDialog
        open={payrollOpen}
        onOpenChange={setPayrollOpen}
        period={activePeriod}
      />
    </div>
  );
}
