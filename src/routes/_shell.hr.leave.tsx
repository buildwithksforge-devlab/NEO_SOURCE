import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarCheck, Plus, RefreshCw } from "lucide-react";
import { PageHeader, SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import { EmptyState, HrBadge, HrGuard, QueryState } from "@/components/hr/HrShared";
import { LeaveDecisionDialog } from "@/components/hr/LeaveDecisionDialog";
import { LeavePolicyDialog } from "@/components/hr/LeavePolicyDialog";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { useLeaveBalances, useLeaveRequests, useLeaveTypes } from "@/lib/hr-data";
import {
  LEAVE_REQUEST_TABS,
  availableDays,
  useEntitlementsUpToDate,
  useSyncEntitlements,
} from "@/lib/hr-leave";
import { HR_MODULES, LEAVE_STATUSES, labelFor, shortDate, toneFor, type Row } from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/leave")({
  head: () => ({
    meta: [
      { title: "Leave Management — HOS Human Resources" },
      {
        name: "description",
        content:
          "Leave requests, approvals, automatically calculated balances and company leave policies.",
      },
      { property: "og:title", content: "Leave Management — HOS Human Resources" },
      {
        property: "og:description",
        content:
          "Leave requests, approvals, automatically calculated balances and company leave policies.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.leave} action="self.view">
      <LeaveScreen />
    </HrGuard>
  ),
});

function LeaveScreen() {
  const { can } = useAuth();
  const requests = useLeaveRequests();
  const balances = useLeaveBalances();
  const types = useLeaveTypes();
  const sync = useSyncEntitlements();
  const [decisionFor, setDecisionFor] = useState<Row | null>(null);
  const [policyFor, setPolicyFor] = useState<{ open: boolean; policy: Row | null }>({
    open: false,
    policy: null,
  });

  // Balances recalculate themselves whenever this screen is opened.
  useEntitlementsUpToDate(null, can(HR_MODULES.leave, "approve"));

  const all = requests.data ?? [];
  const approver = can(HR_MODULES.leave, "approve");
  const canManageTypes = can(HR_MODULES.leave, "types.manage");

  const pending = useMemo(
    () => all.filter((r) => ["submitted", "supervisor_approved"].includes(String(r["status"]))),
    [all],
  );

  const byTab = useMemo(() => {
    const map: Record<string, Row[]> = {};
    for (const tab of LEAVE_REQUEST_TABS) {
      map[tab.key] =
        tab.key === "submitted"
          ? pending
          : all.filter((r) => String(r["status"]) === tab.key);
    }
    return map;
  }, [all, pending]);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Leave Management"
        description="Entitlement is calculated from the company leave policies — never typed in. Balances move only on a decision, and every decision is written to the leave ledger and the audit trail."
        actions={
          approver ? (
            <Button
              variant="outline"
              onClick={() => sync.mutate({})}
              disabled={sync.isPending}
            >
              <RefreshCw className={`mr-2 size-4 ${sync.isPending ? "animate-spin" : ""}`} />
              Recalculate balances
            </Button>
          ) : null
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Requests" value={String(all.length)} icon={CalendarCheck} />
        <StatCard label="Awaiting decision" value={String(pending.length)} tone="warning" />
        <StatCard
          label="Approved"
          value={String(all.filter((r) => r["status"] === "approved").length)}
          tone="success"
        />
        <StatCard label="Leave policies" value={String((types.data ?? []).length)} />
      </div>

      <Tabs defaultValue="submitted">
        <TabsList className="flex-wrap">
          {LEAVE_REQUEST_TABS.map((tab) => (
            <TabsTrigger key={tab.key} value={tab.key}>
              {tab.label}
              {byTab[tab.key]?.length ? ` (${byTab[tab.key]!.length})` : ""}
            </TabsTrigger>
          ))}
          <TabsTrigger value="balances">Balances</TabsTrigger>
          <TabsTrigger value="policies">Leave policies</TabsTrigger>
        </TabsList>

        {LEAVE_REQUEST_TABS.map((tab) => (
          <TabsContent key={tab.key} value={tab.key} className="mt-4">
            <SectionCard title={`${tab.label} requests`}>
              <QueryState
                isLoading={requests.isLoading}
                error={requests.error}
                isEmpty={(byTab[tab.key] ?? []).length === 0}
                empty={
                  <EmptyState
                    title={`No ${tab.label.toLowerCase()} requests`}
                    description="Requests submitted from My HR appear here."
                  />
                }
              >
                <RequestTable
                  rows={byTab[tab.key] ?? []}
                  approver={approver}
                  onOpen={setDecisionFor}
                />
              </QueryState>
            </SectionCard>
          </TabsContent>
        ))}

        <TabsContent value="balances" className="mt-4">
          <SectionCard
            title="Leave balances"
            description={`Calculated for ${new Date().getFullYear()} from each policy and the employee's joining date.`}
          >
            <QueryState
              isLoading={balances.isLoading}
              error={balances.error}
              isEmpty={(balances.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No balances yet"
                  description="Balances appear once leave policies exist and entitlement is recalculated."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Entitlement</TableHead>
                      <TableHead className="text-right">Accrued</TableHead>
                      <TableHead className="text-right">Carried</TableHead>
                      <TableHead className="text-right">Taken</TableHead>
                      <TableHead className="text-right">Pending</TableHead>
                      <TableHead className="text-right">Expired</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(balances.data ?? []).map((b) => (
                      <TableRow key={String(b["id"])}>
                        <TableCell className="font-medium">
                          {(b["employees"] as Row | null)?.["full_name"] ?? "—"}
                        </TableCell>
                        <TableCell>{(b["leave_types"] as Row | null)?.["name"] ?? "—"}</TableCell>
                        <TableCell className="text-right">
                          {Number(b["entitlement_days"] ?? 0)}
                        </TableCell>
                        <TableCell className="text-right">
                          {Number(b["accrued_days"] ?? 0)}
                        </TableCell>
                        <TableCell className="text-right">
                          {Number(b["carried_forward_days"] ?? 0)}
                        </TableCell>
                        <TableCell className="text-right">{Number(b["taken_days"] ?? 0)}</TableCell>
                        <TableCell className="text-right">
                          {Number(b["pending_days"] ?? 0)}
                        </TableCell>
                        <TableCell className="text-right">
                          {Number(b["expired_days"] ?? 0)}
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {availableDays(b)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="policies" className="mt-4">
          <SectionCard
            title="Company leave policies"
            description="Days allowed, accrual, carry-forward, weekend and holiday counting, notice and approval route. Entitlement follows these rules."
            actions={
              canManageTypes ? (
                <Button size="sm" onClick={() => setPolicyFor({ open: true, policy: null })}>
                  <Plus className="mr-2 size-4" aria-hidden />
                  New leave policy
                </Button>
              ) : null
            }
          >
            <QueryState
              isLoading={types.isLoading}
              error={types.error}
              isEmpty={(types.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No leave policies"
                  description="Create the company's leave categories so entitlement can be calculated."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Policy</TableHead>
                      <TableHead>Paid</TableHead>
                      <TableHead className="text-right">Days</TableHead>
                      <TableHead>Accrual</TableHead>
                      <TableHead>Carry forward</TableHead>
                      <TableHead>Counts</TableHead>
                      <TableHead className="text-right">Notice</TableHead>
                      <TableHead>Document</TableHead>
                      {canManageTypes ? <TableHead className="text-right">Edit</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(types.data ?? []).map((t) => (
                      <TableRow key={String(t["id"])}>
                        <TableCell className="font-medium">{String(t["name"])}</TableCell>
                        <TableCell>{t["paid"] ? "Paid" : "Unpaid"}</TableCell>
                        <TableCell className="text-right">
                          {Number(t["annual_entitlement_days"] ?? 0)}
                        </TableCell>
                        <TableCell>
                          {t["accrual_method"] === "monthly" ? "Monthly" : "Annual grant"}
                        </TableCell>
                        <TableCell>
                          {t["carry_forward"]
                            ? `Up to ${t["max_carry_forward_days"] ?? "—"} days`
                            : "No"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {t["counts_weekends"] === false ? "Working days" : "All days"}
                          {t["counts_public_holidays"] === false ? ", no holidays" : ""}
                        </TableCell>
                        <TableCell className="text-right">
                          {Number(t["minimum_notice_days"] ?? 0)}d
                        </TableCell>
                        <TableCell>{t["requires_document"] ? "Required" : "—"}</TableCell>
                        {canManageTypes ? (
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setPolicyFor({ open: true, policy: t })}
                            >
                              Edit
                            </Button>
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>
      </Tabs>

      {approver ? (
        <LeaveDecisionDialog
          request={decisionFor}
          onOpenChange={(v) => {
            if (!v) setDecisionFor(null);
          }}
        />
      ) : null}

      <LeavePolicyDialog
        open={policyFor.open}
        policy={policyFor.policy}
        onOpenChange={(v) => setPolicyFor({ open: v, policy: v ? policyFor.policy : null })}
      />
    </div>
  );
}

function RequestTable({
  rows,
  approver,
  onOpen,
}: {
  rows: Row[];
  approver: boolean;
  onOpen: (row: Row) => void;
}) {
  return (
    <TableScroll>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Employee</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Dates</TableHead>
            <TableHead className="text-right">Days</TableHead>
            <TableHead>Status</TableHead>
            {approver ? <TableHead className="text-right">Decision</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={String(r["id"])}>
              <TableCell className="font-medium">
                {(r["employees"] as Row | null)?.["full_name"] ?? "—"}
              </TableCell>
              <TableCell>{(r["leave_types"] as Row | null)?.["name"] ?? "—"}</TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {shortDate(r["start_date"])} → {shortDate(r["end_date"])}
              </TableCell>
              <TableCell className="text-right">{Number(r["days"] ?? 0)}</TableCell>
              <TableCell>
                <HrBadge
                  value={labelFor(LEAVE_STATUSES, r["status"])}
                  tone={toneFor(LEAVE_STATUSES, r["status"])}
                />
              </TableCell>
              {approver ? (
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" onClick={() => onOpen(r)}>
                    Open
                  </Button>
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableScroll>
  );
}
