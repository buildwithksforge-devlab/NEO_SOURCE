/**
 * Payroll money — preview and posting.
 *
 * The figures come from each employee's recorded pay plus the period's own
 * allowances, bonuses, reimbursements and deductions. Nothing posts until
 * every employee has a pay record and Finance has chosen the accounts.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookCheck } from "lucide-react";
import { SectionCard, StatCard } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/hr/HrShared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { formatMoneyExact } from "@/lib/money-format";
import { HR_MODULES, shortDateTime, type Row } from "@/lib/hr";
import {
  payrollTotals,
  usePayrollComputation,
  usePayrollPostingSettings,
  usePostPayroll,
  usePostableAccounts,
  useSavePayrollPostingSettings,
  useSetPayrollAutoPost,
} from "@/lib/hr-payroll";
import { journalAgrees, usePostedPayrollJournal } from "@/lib/hr-payslips";
import { Switch } from "@/components/ui/switch";

const ACCOUNT_FIELDS = [
  { key: "salary_expense_account_id", label: "Basic pay expense", need: "base" },
  { key: "allowance_expense_account_id", label: "Allowances expense", need: "allowances" },
  { key: "bonus_expense_account_id", label: "Bonuses and commission expense", need: "bonuses" },
  {
    key: "reimbursement_expense_account_id",
    label: "Reimbursements expense",
    need: "reimbursements",
  },
  { key: "deduction_liability_account_id", label: "Deductions payable", need: "deductions" },
  { key: "net_pay_liability_account_id", label: "Net pay payable", need: "net" },
] as const;

export function PayrollPostingPanel({ period }: { period: Row | undefined }) {
  const { can } = useAuth();
  const periodId = period ? String(period["id"]) : undefined;
  const computation = usePayrollComputation(periodId);
  const settings = usePayrollPostingSettings(period ? (period["branch_id"] as string | null) : null);
  const accounts = usePostableAccounts();
  const saveSettings = useSavePayrollPostingSettings();
  const post = usePostPayroll();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!settings.data) return;
    const next: Record<string, string> = {};
    for (const f of ACCOUNT_FIELDS) next[f.key] = String((settings.data as Row)[f.key] ?? "");
    setDraft(next);
  }, [settings.data]);

  const rows = computation.data ?? [];
  const totals = useMemo(() => payrollTotals(rows), [rows]);
  const mayApprove = can(HR_MODULES.payroll, "approve");
  const status = String(period?.["status"] ?? "");
  const posted = Boolean(period?.["posted_journal_id"]);

  const missingAccounts = ACCOUNT_FIELDS.filter((f) => {
    const amount =
      f.need === "net" ? totals.net : Number((totals as unknown as Record<string, unknown>)[f.need] ?? 0);
    return amount !== 0 && !(settings.data as Row | null)?.[f.key];
  });

  const readyStatus = status === "approved" || status === "locked";
  const blockers: string[] = [];
  if (!readyStatus && !posted)
    blockers.push("The period must be approved or locked before it can be posted.");
  if (!computation.isLoading && rows.length === 0)
    blockers.push("This period has no payroll input records, so there is nothing to post.");
  if (totals.missing > 0)
    blockers.push(`${totals.missing} employee(s) have no pay record on their profile.`);
  if (missingAccounts.length)
    blockers.push(
      `Choose accounts for: ${missingAccounts.map((f) => f.label.toLowerCase()).join(", ")}.`,
    );

  /* ---------------------- automatic posting (switchable) -------------------- */

  const journal = usePostedPayrollJournal((period?.["posted_journal_id"] as string | null) ?? null);
  const agreement = journalAgrees(journal.data, totals);

  const setAutoPost = useSetPayrollAutoPost();
  const autoPost = Boolean((settings.data as Row | null)?.["auto_post_enabled"]);
  const attempted = useRef<Set<string>>(new Set());
  const ready = Boolean(periodId) && !posted && blockers.length === 0 && !computation.isLoading;

  useEffect(() => {
    // Automatic posting uses the same guarded, single-shot routine as the
    // button. It only fires for a period that is already clear to post, and
    // only once per period in this session; the routine itself refuses a
    // second journal.
    if (!autoPost || !ready || !mayApprove || !periodId) return;
    if (post.isPending || attempted.current.has(periodId)) return;
    attempted.current.add(periodId);
    post.mutate(periodId);
  }, [autoPost, ready, mayApprove, periodId, post]);

  return (
    <SectionCard
      title="Pay and posting"
      description={
        autoPost
          ? "What this period costs. Automatic posting is on: a period with no blockers posts itself to the finance books, using the pay recorded on each employee's profile."
          : "What this period costs, and the entry it will write to the finance books. Automatic posting is off, so payroll posts only when you press the button."
      }
      actions={
        <div className="flex flex-wrap items-center gap-3">
          {mayApprove ? (
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={autoPost}
                disabled={setAutoPost.isPending}
                onCheckedChange={(checked) =>
                  setAutoPost.mutate({
                    ...(settings.data ? { id: String((settings.data as Row)["id"]) } : {}),
                    branch_id: (period?.["branch_id"] as string | null) ?? null,
                    enabled: checked,
                  })
                }
              />
              Post automatically
            </label>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Finance accounts
          </Button>
          {mayApprove && periodId ? (
            <Button
              size="sm"
              onClick={() => post.mutate(periodId)}
              disabled={post.isPending || posted || blockers.length > 0}
            >
              <BookCheck className="mr-2 size-4" />
              {posted ? "Posted" : "Post to finance"}
            </Button>
          ) : null}
        </div>
      }
    >
      <QueryState
        isLoading={computation.isLoading}
        error={computation.error}
        isEmpty={rows.length === 0}
        query={computation}
        empty={
          <EmptyState
            title="Nothing to price yet"
            description="Build the period's inputs first, then each employee's recorded pay is applied here."
          />
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Gross" value={formatMoneyExact(totals.gross, totals.currency)} />
            <StatCard
              label="Deductions"
              value={formatMoneyExact(totals.deductions, totals.currency)}
            />
            <StatCard
              label="Net pay"
              value={formatMoneyExact(totals.net, totals.currency)}
              tone="success"
            />
            <StatCard
              label="Missing pay records"
              value={String(totals.missing)}
              tone={totals.missing ? "warning" : "default"}
            />
          </div>

          {posted ? (
            <div className="space-y-2 rounded-lg border border-border/70 bg-muted/40 p-3 text-sm">
              <p>
                Posted {shortDateTime(period?.["posted_at"])}
                {journal.data ? ` — journal ${String(journal.data["journal_number"] ?? "")}` : " — journal recorded in Finance"}
                . Posting again will not create a second entry.
              </p>
              {journal.data ? (
                <div className="grid gap-1 sm:grid-cols-3">
                  <span className="text-muted-foreground">
                    Ledger debit {formatMoneyExact(agreement.debit, totals.currency)}
                  </span>
                  <span className="text-muted-foreground">
                    Ledger credit {formatMoneyExact(agreement.credit, totals.currency)}
                  </span>
                  <span className="text-muted-foreground">
                    Payroll gross {formatMoneyExact(agreement.expected, totals.currency)}
                  </span>
                </div>
              ) : null}
              {journal.data ? (
                <Badge variant={agreement.agrees ? "default" : "destructive"}>
                  {agreement.agrees
                    ? "Ledger agrees with payroll"
                    : "Ledger does not agree with payroll — check the journal"}
                </Badge>
              ) : null}
            </div>
          ) : blockers.length ? (
            <div className="rounded-lg border border-dashed border-border/70 bg-muted/40 p-3 text-sm">
              <p className="mb-1 flex items-center gap-2 font-medium">
                <AlertTriangle className="size-4 text-muted-foreground" />
                Not ready to post
              </p>
              <ul className="list-disc space-y-1 pl-6 text-muted-foreground">
                {blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead className="text-right">Basic</TableHead>
                  <TableHead className="text-right">Allowances</TableHead>
                  <TableHead className="text-right">Bonuses</TableHead>
                  <TableHead className="text-right">Reimbursed</TableHead>
                  <TableHead className="text-right">Deductions</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.employee_id}>
                    <TableCell className="font-medium">
                      {r.full_name}
                      {r.missing_compensation ? (
                        <Badge variant="outline" className="ml-2">
                          No pay record
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.missing_compensation ? "—" : formatMoneyExact(r.base_pay, r.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoneyExact(r.allowances, r.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoneyExact(r.bonuses, r.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoneyExact(r.reimbursements, r.currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatMoneyExact(r.deductions, r.currency)}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {r.missing_compensation ? "—" : formatMoneyExact(r.net_pay, r.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </QueryState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Finance accounts for payroll</DialogTitle>
            <DialogDescription>
              Choose the account each part of payroll lands in. Only accounts from your chart are
              offered; nothing is chosen for you.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {ACCOUNT_FIELDS.map((f) => (
              <div key={f.key} className="space-y-2">
                <Label>{f.label}</Label>
                <Select
                  value={draft[f.key] ?? ""}
                  onValueChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Not chosen" />
                  </SelectTrigger>
                  <SelectContent>
                    {(accounts.data ?? []).map((a) => (
                      <SelectItem key={String(a["id"])} value={String(a["id"])}>
                        {String(a["code"])} — {String(a["name"])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={saveSettings.isPending}
              onClick={() => {
                const values: Row = {};
                for (const f of ACCOUNT_FIELDS) values[f.key] = draft[f.key] || null;
                saveSettings.mutate(
                  {
                    ...(settings.data ? { id: String((settings.data as Row)["id"]) } : {}),
                    branch_id: (period?.["branch_id"] as string | null) ?? null,
                    accounts: values,
                  },
                  { onSuccess: () => setOpen(false) },
                );
              }}
            >
              Save accounts
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
