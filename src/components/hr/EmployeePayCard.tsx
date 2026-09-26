/**
 * Pay record for one employee.
 *
 * HR types the real figure agreed with the person. Nothing is suggested,
 * defaulted or carried over from another employee. Each entry has an effective
 * date, so a raise is a new record and the history stays intact.
 */

import { useState } from "react";
import { SectionCard } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { EmptyState, QueryState } from "@/components/hr/HrShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import {
  useEmployeeCompensation,
  usePayrollPostingSettings,
  useSaveCompensation,
} from "@/lib/hr-payroll";
import { HR_MODULES, shortDate, titleCase, today, type Row } from "@/lib/hr";

const FREQUENCIES = [
  { key: "monthly", label: "Monthly salary" },
  { key: "daily", label: "Daily rate" },
  { key: "hourly", label: "Hourly rate" },
] as const;

export function EmployeePayCard({
  employeeId,
  branchId,
}: {
  employeeId: string;
  branchId: string | null;
}) {
  const { can } = useAuth();
  const records = useEmployeeCompensation(employeeId);
  const posting = usePayrollPostingSettings(branchId);
  const autoPost = Boolean(posting.data?.["auto_post_enabled"]);
  const save = useSaveCompensation();
  const [open, setOpen] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState<string>(today());
  const [frequency, setFrequency] = useState<string>("monthly");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("KES");
  const [notes, setNotes] = useState("");

  const mayEdit = can(HR_MODULES.payroll, "inputs.edit");
  const current = (records.data ?? [])[0] ?? null;
  const parsed = Number(amount);
  const valid = effectiveFrom !== "" && Number.isFinite(parsed) && parsed >= 0 && amount !== "";

  function submit() {
    if (!valid) return;
    save.mutate(
      {
        employee_id: employeeId,
        branch_id: branchId,
        effective_from: effectiveFrom,
        pay_frequency: frequency,
        base_amount: Math.round(parsed * 100) / 100,
        currency: currency.trim().toUpperCase() || "KES",
        notes: notes.trim() || null,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setAmount("");
          setNotes("");
        },
      },
    );
  }

  return (
    <SectionCard
      title="Pay record"
      description={
        autoPost
          ? "The agreed base pay. Payroll is posted to the finance books automatically from this figure once the period is approved — no entry is typed in Finance. Allowances, bonuses and deductions are entered per period."
          : "The agreed base pay used when a payroll period is posted to the finance books. Automatic posting is currently off, so Finance posts the period by hand. Allowances, bonuses and deductions are entered per period."
      }
      actions={
        mayEdit ? (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Record pay
          </Button>
        ) : null
      }
    >
      <QueryState
        isLoading={records.isLoading}
        error={records.error}
        isEmpty={(records.data ?? []).length === 0}
        empty={
          <EmptyState
            title="No pay recorded"
            description="Payroll for this person cannot be posted until their agreed pay is entered here."
          />
        }
      >
        <>
          {current ? (
            <p className="mb-3 text-sm text-muted-foreground">
              Currently{" "}
              <span className="font-medium text-foreground">
                {formatMoneyExact(current["base_amount"], String(current["currency"] ?? "KES"))}
              </span>{" "}
              · {titleCase(current["pay_frequency"])} · effective{" "}
              {shortDate(current["effective_from"])}
            </p>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Effective from</TableHead>
                <TableHead>Basis</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(records.data ?? []).map((r: Row) => (
                <TableRow key={String(r["id"])}>
                  <TableCell>{shortDate(r["effective_from"])}</TableCell>
                  <TableCell>{titleCase(r["pay_frequency"])}</TableCell>
                  <TableCell className="text-right">
                    {formatMoneyExact(r["base_amount"], String(r["currency"] ?? "KES"))}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {String(r["notes"] ?? "—")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      </QueryState>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record pay</DialogTitle>
            <DialogDescription>
              Enter the figure actually agreed with this employee. A change is a new record from
              its own effective date; earlier records stay for history.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="pay-effective">Effective from</Label>
              <NeoDatePicker
                id="pay-effective"
                value={effectiveFrom}
                onChange={(v) => setEffectiveFrom(v ?? "")}
              />
            </div>
            <div className="space-y-2">
              <Label>Paid as</Label>
              <Select value={frequency} onValueChange={setFrequency}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCIES.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                A daily or hourly rate is multiplied by the days or hours in the payroll period.
              </p>
            </div>
            <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
              <div className="space-y-2">
                <Label htmlFor="pay-amount">Amount</Label>
                <Input
                  id="pay-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pay-currency">Currency</Label>
                <Input
                  id="pay-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="pay-note">Note</Label>
              <Textarea
                id="pay-note"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Reason for the change, reference to the signed letter…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={!valid || save.isPending}>
              Save pay record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
