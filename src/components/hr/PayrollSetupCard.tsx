/**
 * Payroll setup for one employee.
 *
 * Two facts live here and nowhere else: whether this person is in payroll at
 * all (with the date it takes effect), and how they are actually paid. Neither
 * is inferred from having a login account, and enrolment is refused until a
 * real pay record exists, so a period can never price somebody at zero.
 */

import { useEffect, useState } from "react";
import { SectionCard } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { HR_MODULES, shortDate, today, type Row } from "@/lib/hr";
import {
  useEmployeePaymentDetails,
  useSavePaymentDetails,
  useSetPayrollEnrolment,
} from "@/lib/hr-payroll";

const METHODS = [
  { key: "bank_transfer", label: "Bank transfer" },
  { key: "mobile_money", label: "Mobile money" },
  { key: "cash", label: "Cash" },
  { key: "cheque", label: "Cheque" },
] as const;

export function PayrollSetupCard({
  employee,
  branchId,
}: {
  employee: Row;
  branchId: string | null;
}) {
  const { can } = useAuth();
  const employeeId = String(employee["id"]);
  const mayEdit = can(HR_MODULES.payroll, "inputs.edit");
  const details = useEmployeePaymentDetails(employeeId);
  const savePayment = useSavePaymentDetails();
  const setEnrolment = useSetPayrollEnrolment();

  const enrolled = String(employee["payroll_status"] ?? "") === "active";
  const [effective, setEffective] = useState<string>(
    (employee["payroll_effective_from"] as string | null) ?? today(),
  );

  const current = details.data ?? null;
  const [method, setMethod] = useState("bank_transfer");
  const [bankName, setBankName] = useState("");
  const [bankBranch, setBankBranch] = useState("");
  const [accountName, setAccountName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!current) return;
    setMethod(String(current["payment_method"] ?? "bank_transfer"));
    setBankName(String(current["bank_name"] ?? ""));
    setBankBranch(String(current["bank_branch"] ?? ""));
    setAccountName(String(current["account_name"] ?? ""));
    setAccountNumber(String(current["account_number"] ?? ""));
    setMobileNumber(String(current["mobile_money_number"] ?? ""));
    setNotes(String(current["notes"] ?? ""));
  }, [current]);

  function savePaymentDetails() {
    savePayment.mutate({
      id: current ? String(current["id"]) : undefined,
      employee_id: employeeId,
      branch_id: branchId,
      payment_method: method,
      bank_name: bankName.trim() || null,
      bank_branch: bankBranch.trim() || null,
      account_name: accountName.trim() || null,
      account_number: accountNumber.trim() || null,
      mobile_money_number: mobileNumber.trim() || null,
      notes: notes.trim() || null,
    });
  }

  return (
    <SectionCard
      title="Payroll setup"
      description="Whether this person is in payroll, from when, and how they are paid. Enrolment is refused until their agreed pay has been recorded."
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-end gap-4 rounded-lg border border-border/60 p-4">
          <div className="flex items-center gap-3">
            <Switch
              id="payroll-active"
              checked={enrolled}
              disabled={!mayEdit || setEnrolment.isPending}
              onCheckedChange={(next) =>
                setEnrolment.mutate({
                  employee_id: employeeId,
                  active: next,
                  effective_from: effective || today(),
                })
              }
            />
            <Label htmlFor="payroll-active">
              {enrolled ? "In payroll" : "Not in payroll"}
            </Label>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="payroll-effective">Effective from</Label>
            <NeoDatePicker
              id="payroll-effective"
              value={effective}
              onChange={(v) => setEffective(v ?? "")}
            />
          </div>
          {employee["payroll_effective_from"] ? (
            <p className="text-sm text-muted-foreground">
              Recorded {enrolled ? "in payroll" : "out of payroll"} from{" "}
              {shortDate(employee["payroll_effective_from"])}.
            </p>
          ) : null}
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Paid by</Label>
            <Select value={method} onValueChange={setMethod} disabled={!mayEdit}>
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
                <Label htmlFor="pay-bank">Bank</Label>
                <Input
                  id="pay-bank"
                  value={bankName}
                  disabled={!mayEdit}
                  onChange={(e) => setBankName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pay-bank-branch">Bank branch</Label>
                <Input
                  id="pay-bank-branch"
                  value={bankBranch}
                  disabled={!mayEdit}
                  onChange={(e) => setBankBranch(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pay-acc-name">Account name</Label>
                <Input
                  id="pay-acc-name"
                  value={accountName}
                  disabled={!mayEdit}
                  onChange={(e) => setAccountName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pay-acc-number">Account number</Label>
                <Input
                  id="pay-acc-number"
                  value={accountNumber}
                  disabled={!mayEdit}
                  onChange={(e) => setAccountNumber(e.target.value)}
                />
              </div>
            </div>
          ) : null}

          {method === "mobile_money" ? (
            <div className="space-y-2 sm:max-w-xs">
              <Label htmlFor="pay-mobile">Mobile money number</Label>
              <Input
                id="pay-mobile"
                value={mobileNumber}
                disabled={!mayEdit}
                onChange={(e) => setMobileNumber(e.target.value)}
              />
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="pay-notes">Note</Label>
            <Textarea
              id="pay-notes"
              value={notes}
              disabled={!mayEdit}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything payroll needs to know about how this person is paid."
            />
          </div>

          {mayEdit ? (
            <Button onClick={savePaymentDetails} disabled={savePayment.isPending}>
              Save payment details
            </Button>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}
