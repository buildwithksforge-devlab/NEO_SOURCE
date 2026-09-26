/**
 * Bulk payroll onboarding.
 *
 * The same three writes as the one-person path — agreed pay, payment details,
 * payroll enrolment — applied to several colleagues in one sitting. Nothing is
 * copied between people and nothing is defaulted: a row is only saved when the
 * figures for that row have actually been typed, and any row that fails is
 * reported by name instead of being silently skipped.
 */

import { useMemo, useState } from "react";
import { Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { useAuth } from "@/lib/auth";
import { HR_MODULES, today } from "@/lib/hr";
import {
  usePayrollEnrolment,
  useSaveCompensation,
  useSavePaymentDetails,
  useSetPayrollEnrolment,
} from "@/lib/hr-payroll";

const FREQUENCIES = [
  { key: "monthly", label: "Monthly salary" },
  { key: "daily", label: "Daily rate" },
  { key: "hourly", label: "Hourly rate" },
] as const;

const METHODS = [
  { key: "bank_transfer", label: "Bank transfer" },
  { key: "mobile_money", label: "Mobile money" },
  { key: "cash", label: "Cash" },
  { key: "cheque", label: "Cheque" },
] as const;

type RowState = {
  selected: boolean;
  amount: string;
  frequency: string;
  method: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  mobileNumber: string;
};

const BLANK: RowState = {
  selected: false,
  amount: "",
  frequency: "monthly",
  method: "bank_transfer",
  bankName: "",
  accountName: "",
  accountNumber: "",
  mobileNumber: "",
};

function rowReady(row: RowState): boolean {
  const amount = Number(row.amount);
  if (row.amount === "" || !Number.isFinite(amount) || amount < 0) return false;
  if (row.method === "mobile_money") return row.mobileNumber.trim() !== "";
  if (row.method === "bank_transfer" || row.method === "cheque")
    return row.bankName.trim() !== "" && row.accountNumber.trim() !== "";
  return true;
}

export function BulkPayrollOnboardingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const { can } = useAuth();
  const mayEdit = can(HR_MODULES.payroll, "inputs.edit");
  const enrolment = usePayrollEnrolment();
  const saveCompensation = useSaveCompensation();
  const savePayment = useSavePaymentDetails();
  const setEnrolment = useSetPayrollEnrolment();

  const [effectiveFrom, setEffectiveFrom] = useState<string>(today());
  const [currency, setCurrency] = useState("KES");
  const [state, setState] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);
  const [failures, setFailures] = useState<{ name: string; reason: string }[]>([]);

  const people = useMemo(
    () => (enrolment.data ?? []).filter((p) => p.base_amount === null || p.payroll_status !== "active"),
    [enrolment.data],
  );

  const get = (id: string): RowState => state[id] ?? BLANK;
  const set = (id: string, patch: Partial<RowState>) =>
    setState((prev) => ({ ...prev, [id]: { ...(prev[id] ?? BLANK), ...patch } }));

  const chosen = people.filter((p) => get(p.employee_id).selected);
  const ready = chosen.filter((p) => rowReady(get(p.employee_id)));

  async function saveAll() {
    setRunning(true);
    setFailures([]);
    const failed: { name: string; reason: string }[] = [];
    let done = 0;
    for (const person of ready) {
      const row = get(person.employee_id);
      try {
        await saveCompensation.mutateAsync({
          employee_id: person.employee_id,
          branch_id: person.branch_id ?? null,
          effective_from: effectiveFrom,
          pay_frequency: row.frequency,
          base_amount: Number(row.amount),
          currency,
        });
        await savePayment.mutateAsync({
          employee_id: person.employee_id,
          branch_id: person.branch_id ?? null,
          payment_method: row.method,
          bank_name: row.bankName.trim() || null,
          bank_branch: null,
          account_name: row.accountName.trim() || null,
          account_number: row.accountNumber.trim() || null,
          mobile_money_number: row.mobileNumber.trim() || null,
          notes: null,
        });
        await setEnrolment.mutateAsync({
          employee_id: person.employee_id,
          active: true,
          effective_from: effectiveFrom,
        });
        done += 1;
      } catch (error) {
        failed.push({ name: person.full_name, reason: (error as Error).message });
      }
    }
    setRunning(false);
    setFailures(failed);
    if (done) toast.success(`${done} ${done === 1 ? "person" : "people"} put on payroll`);
    if (!failed.length) {
      setState({});
      onOpenChange(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-5" aria-hidden />
            Put several people on payroll
          </DialogTitle>
          <DialogDescription>
            Enter each person's agreed pay and how they are paid. Rows left blank are not saved, and
            no figure is copied from one person to another.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Pay applies from</Label>
            <NeoDatePicker value={effectiveFrom} onChange={(v) => setEffectiveFrom(v ?? today())} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="bulk-currency">Currency</Label>
            <Input
              id="bulk-currency"
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </div>
        </div>

        {people.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
            Everyone with an employee record already has agreed pay and is enrolled in payroll.
          </p>
        ) : (
          <div className="space-y-3">
            {people.map((person) => {
              const row = get(person.employee_id);
              return (
                <div
                  key={person.employee_id}
                  className="rounded-lg border border-border/70 bg-card/40 p-3"
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={row.selected}
                      onCheckedChange={(checked) =>
                        set(person.employee_id, { selected: checked === true })
                      }
                      aria-label={`Include ${person.full_name}`}
                    />
                    <div className="min-w-0">
                      <p className="truncate font-medium">{person.full_name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {person.employee_number ?? "No HR number"} · {person.job_title ?? "No job title"}
                      </p>
                    </div>
                  </div>

                  {row.selected ? (
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Pay frequency</Label>
                        <Select
                          value={row.frequency}
                          onValueChange={(v) => set(person.employee_id, { frequency: v })}
                        >
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
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Agreed amount</Label>
                        <Input
                          inputMode="decimal"
                          value={row.amount}
                          onChange={(e) => set(person.employee_id, { amount: e.target.value })}
                          placeholder="Enter the agreed figure"
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Paid by</Label>
                        <Select
                          value={row.method}
                          onValueChange={(v) => set(person.employee_id, { method: v })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {METHODS.map((m) => (
                              <SelectItem key={m.key} value={m.key}>
                                {m.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      {row.method === "mobile_money" ? (
                        <div className="space-y-1">
                          <Label className="text-xs">Mobile number</Label>
                          <Input
                            value={row.mobileNumber}
                            onChange={(e) =>
                              set(person.employee_id, { mobileNumber: e.target.value })
                            }
                          />
                        </div>
                      ) : null}

                      {row.method === "bank_transfer" || row.method === "cheque" ? (
                        <>
                          <div className="space-y-1">
                            <Label className="text-xs">Bank</Label>
                            <Input
                              value={row.bankName}
                              onChange={(e) => set(person.employee_id, { bankName: e.target.value })}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Account name</Label>
                            <Input
                              value={row.accountName}
                              onChange={(e) =>
                                set(person.employee_id, { accountName: e.target.value })
                              }
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Account number</Label>
                            <Input
                              value={row.accountNumber}
                              onChange={(e) =>
                                set(person.employee_id, { accountNumber: e.target.value })
                              }
                            />
                          </div>
                        </>
                      ) : null}

                      {!rowReady(row) ? (
                        <p className="md:col-span-3 text-xs text-muted-foreground">
                          Still needed for this person: the agreed amount and how they are paid.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {failures.length ? (
          <ul className="list-disc space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 p-3 pl-8 text-sm">
            {failures.map((f) => (
              <li key={f.name}>
                <span className="font-medium">{f.name}</span> — {f.reason}
              </li>
            ))}
          </ul>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            Cancel
          </Button>
          <Button onClick={saveAll} disabled={!mayEdit || running || ready.length === 0}>
            {running ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            Save {ready.length || ""} {ready.length === 1 ? "person" : "people"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
