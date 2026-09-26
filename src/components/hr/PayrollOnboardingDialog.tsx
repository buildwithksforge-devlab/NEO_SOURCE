/**
 * Payroll onboarding — one guided path for putting an existing person on payroll.
 *
 * It never creates a second copy of a person: step one picks an existing
 * employee record, and every later step writes against that same employee id.
 * Nothing is defaulted or inferred — the pay figure and the payment details are
 * typed by HR, and enrolment only happens once a real pay record exists.
 */

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { useAuth } from "@/lib/auth";
import { HR_MODULES, today, type Row } from "@/lib/hr";
import { useBuildPayrollInputs } from "@/lib/hr-data";
import {
  usePayrollEnrolment,
  useSaveCompensation,
  useSavePaymentDetails,
  useSetPayrollEnrolment,
  type PayrollEnrolmentRow,
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

const STEPS = ["Employee", "Pay", "Payment details", "Pay period"] as const;

export function PayrollOnboardingDialog({
  open,
  onOpenChange,
  period,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  period: Row | undefined;
}) {
  const { can } = useAuth();
  const mayEdit = can(HR_MODULES.payroll, "inputs.edit");
  const enrolment = usePayrollEnrolment();
  const saveCompensation = useSaveCompensation();
  const savePayment = useSavePaymentDetails();
  const setEnrolment = useSetPayrollEnrolment();
  const buildInputs = useBuildPayrollInputs();

  const [step, setStep] = useState(0);
  const [employeeId, setEmployeeId] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState<string>(today());
  const [frequency, setFrequency] = useState<string>("monthly");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("KES");
  const [payNotes, setPayNotes] = useState("");
  const [method, setMethod] = useState<string>("bank_transfer");
  const [bankName, setBankName] = useState("");
  const [bankBranch, setBankBranch] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");

  const people = enrolment.data ?? [];
  const candidates = useMemo(
    () => people.filter((p) => p.base_amount === null || p.payroll_status !== "active"),
    [people],
  );
  const selected: PayrollEnrolmentRow | undefined = people.find(
    (p) => p.employee_id === employeeId,
  );

  function reset() {
    setStep(0);
    setEmployeeId("");
    setAmount("");
    setPayNotes("");
    setBankName("");
    setBankBranch("");
    setAccountName("");
    setAccountNumber("");
    setMobileNumber("");
  }

  function close(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  const parsed = Number(amount);
  const payValid = amount !== "" && Number.isFinite(parsed) && parsed >= 0 && effectiveFrom !== "";
  const paymentValid =
    method === "cash" ||
    (method === "mobile_money"
      ? mobileNumber.trim() !== ""
      : accountName.trim() !== "" && accountNumber.trim() !== "" && bankName.trim() !== "");

  const busy =
    saveCompensation.isPending ||
    savePayment.isPending ||
    setEnrolment.isPending ||
    buildInputs.isPending;

  function savePay() {
    if (!selected || !payValid) return;
    saveCompensation.mutate(
      {
        employee_id: selected.employee_id,
        branch_id: selected.branch_id,
        effective_from: effectiveFrom,
        pay_frequency: frequency,
        base_amount: Math.round(parsed * 100) / 100,
        currency: currency.trim().toUpperCase() || "KES",
        notes: payNotes.trim() || null,
      },
      { onSuccess: () => setStep(2) },
    );
  }

  function savePaymentAndEnrol() {
    if (!selected || !paymentValid) return;
    savePayment.mutate(
      {
        employee_id: selected.employee_id,
        branch_id: selected.branch_id,
        payment_method: method,
        bank_name: bankName.trim() || null,
        bank_branch: bankBranch.trim() || null,
        account_name: accountName.trim() || null,
        account_number: accountNumber.trim() || null,
        mobile_money_number: mobileNumber.trim() || null,
        notes: null,
      },
      {
        onSuccess: () =>
          setEnrolment.mutate(
            {
              employee_id: selected.employee_id,
              active: true,
              effective_from: effectiveFrom || today(),
            },
            { onSuccess: () => setStep(3) },
          ),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Put someone on payroll</DialogTitle>
          <DialogDescription>
            Links an existing employee record to payroll. No new person is created, and no figure is
            entered for you.
          </DialogDescription>
        </DialogHeader>

        <ol className="flex flex-wrap gap-2 text-xs">
          {STEPS.map((label, i) => (
            <li
              key={label}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
                i === step
                  ? "border-primary text-primary"
                  : i < step
                    ? "border-border text-muted-foreground"
                    : "border-dashed border-border/60 text-muted-foreground"
              }`}
            >
              {i < step ? <Check className="size-3" /> : null}
              {label}
            </li>
          ))}
        </ol>

        <div className="max-h-[55vh] space-y-4 overflow-y-auto pr-1">
          {step === 0 ? (
            <div className="space-y-2">
              <Label>Employee</Label>
              <Select value={employeeId} onValueChange={setEmployeeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose an existing employee" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((p) => (
                    <SelectItem key={p.employee_id} value={p.employee_id}>
                      {p.full_name}
                      {p.employee_number ? ` · ${p.employee_number}` : ""}
                      {p.base_amount === null ? " · no pay recorded" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {enrolment.isLoading
                  ? "Loading employee records…"
                  : candidates.length === 0
                    ? "Everyone with an employee record is already on payroll."
                    : `${candidates.length} employee record(s) not yet fully on payroll.`}
              </p>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Effective from</Label>
                <NeoDatePicker value={effectiveFrom} onChange={(v) => setEffectiveFrom(v ?? "")} />
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
              </div>
              <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
                <div className="space-y-2">
                  <Label htmlFor="onb-amount">Agreed amount</Label>
                  <Input
                    id="onb-amount"
                    inputMode="decimal"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="The figure agreed with this person"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="onb-currency">Currency</Label>
                  <Input
                    id="onb-currency"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="onb-notes">Note</Label>
                <Textarea
                  id="onb-notes"
                  value={payNotes}
                  onChange={(e) => setPayNotes(e.target.value)}
                  placeholder="Optional — what this figure covers."
                />
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Paid by</Label>
                <Select value={method} onValueChange={setMethod}>
                  <SelectTrigger className="max-w-xs">
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

              {method === "bank_transfer" || method === "cheque" ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="onb-bank">Bank</Label>
                    <Input
                      id="onb-bank"
                      value={bankName}
                      onChange={(e) => setBankName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="onb-bank-branch">Bank branch</Label>
                    <Input
                      id="onb-bank-branch"
                      value={bankBranch}
                      onChange={(e) => setBankBranch(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="onb-acc-name">Account name</Label>
                    <Input
                      id="onb-acc-name"
                      value={accountName}
                      onChange={(e) => setAccountName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="onb-acc-number">Account number</Label>
                    <Input
                      id="onb-acc-number"
                      value={accountNumber}
                      onChange={(e) => setAccountNumber(e.target.value)}
                    />
                  </div>
                </div>
              ) : null}

              {method === "mobile_money" ? (
                <div className="space-y-2 sm:max-w-xs">
                  <Label htmlFor="onb-mobile">Mobile money number</Label>
                  <Input
                    id="onb-mobile"
                    value={mobileNumber}
                    onChange={(e) => setMobileNumber(e.target.value)}
                  />
                </div>
              ) : null}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-3 text-sm">
              <p>
                {selected?.full_name} is now on payroll from {effectiveFrom}, with their pay and
                payment details recorded on their own employee record.
              </p>
              {period ? (
                <p className="text-muted-foreground">
                  Add them to <span className="font-medium">{String(period["name"] ?? "the open period")}</span>{" "}
                  by rebuilding that period's inputs from approved attendance. Only hours that have
                  actually been approved are counted.
                </p>
              ) : (
                <p className="text-muted-foreground">
                  There is no open payroll period yet. Create one, then build its inputs to include
                  this person.
                </p>
              )}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          {step > 0 && step < 3 ? (
            <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={busy}>
              Back
            </Button>
          ) : null}

          {step === 0 ? (
            <Button disabled={!employeeId || !mayEdit} onClick={() => setStep(1)}>
              Continue
            </Button>
          ) : null}
          {step === 1 ? (
            <Button disabled={!payValid || busy} onClick={savePay}>
              Save pay and continue
            </Button>
          ) : null}
          {step === 2 ? (
            <Button disabled={!paymentValid || busy} onClick={savePaymentAndEnrol}>
              Save details and enrol
            </Button>
          ) : null}
          {step === 3 ? (
            <>
              <Button variant="ghost" onClick={() => close(false)}>
                Done
              </Button>
              {period ? (
                <Button
                  disabled={busy}
                  onClick={() =>
                    buildInputs.mutate(period, { onSuccess: () => close(false) })
                  }
                >
                  Add to this period
                </Button>
              ) : null}
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
