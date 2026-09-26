/**
 * Record completeness and offboarding controls for a single employee.
 *
 * Nothing here fills a fact in on the employee's behalf. Where a human-entered
 * fact is missing the card says so plainly, so a reconciled record is visibly
 * incomplete rather than quietly passing for a finished one.
 */

import { useState } from "react";
import { SectionCard } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { HrBadge } from "@/components/hr/HrShared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import { HR_MODULES, type Row } from "@/lib/hr";
import { useHrOffboardEmployee } from "@/lib/hr-data";
import {
  READINESS_SECTION_LABELS,
  employeeReadiness,
  readinessSummary,
  type ReadinessSectionKey,
} from "@/lib/hr-readiness";

const SEPARATION_TYPES = [
  { key: "resignation", label: "Resignation" },
  { key: "end_of_contract", label: "End of contract" },
  { key: "retirement", label: "Retirement" },
  { key: "dismissal", label: "Dismissal" },
  { key: "redundancy", label: "Redundancy" },
];

export function EmployeeReadinessCard({ employee }: { employee: Row }) {
  const { can } = useAuth();
  const readiness = employeeReadiness(employee);
  const mayEdit = can(HR_MODULES.employees, "edit");
  const exited = String(employee["employment_status"] ?? "") === "exited";

  const grouped = readiness.missing.reduce<Record<string, string[]>>((acc, item) => {
    const key = item.section;
    (acc[key] ??= []).push(item.label);
    return acc;
  }, {});

  return (
    <SectionCard
      title="Record readiness"
      description="Employment facts are entered by HR — the system never fills them in on your behalf."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <HrBadge value={readiness.label} tone={readiness.tone} />
          <span className="text-sm text-muted-foreground">{readiness.percent}% of tracked facts recorded</span>
          <HrBadge
            value={readiness.payrollReady ? "Payroll ready" : "Not payroll ready"}
            tone={readiness.payrollReady ? "success" : "warning"}
          />
        </div>

        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${readiness.percent}%` }}
          />
        </div>

        {readiness.complete ? (
          <p className="text-sm text-muted-foreground">{readinessSummary(readiness)}</p>
        ) : (
          <div className="space-y-2">
            {Object.entries(grouped).map(([section, labels]) => (
              <div key={section} className="text-sm">
                <span className="font-medium">
                  {READINESS_SECTION_LABELS[section as ReadinessSectionKey] ?? section}:
                </span>{" "}
                <span className="text-muted-foreground">{labels.join(", ")}</span>
              </div>
            ))}
            {readiness.payrollBlockers.length > 0 ? (
              <p className="text-sm text-destructive">
                Payroll cannot include this person until the placement and employment terms above are recorded.
              </p>
            ) : null}
          </div>
        )}

        {mayEdit && !exited ? <OffboardDialog employee={employee} /> : null}
        {exited ? (
          <p className="text-sm text-muted-foreground">
            Employment has ended. The record is retained for history and reporting.
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}

function OffboardDialog({ employee }: { employee: Row }) {
  const offboard = useHrOffboardEmployee();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("resignation");
  const [lastDay, setLastDay] = useState("");
  const [reason, setReason] = useState("");
  const [revoke, setRevoke] = useState(true);
  const hasAccount = Boolean(employee["profile_id"]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">End employment</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>End employment</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Separation type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SEPARATION_TYPES.map((s) => (
                  <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Last working day</Label>
            <NeoDatePicker value={lastDay} onChange={setLastDay} />
          </div>
          <div>
            <Label>Reason (recorded on the employment history)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
          </div>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={revoke}
              disabled={!hasAccount}
              onCheckedChange={(v) => setRevoke(Boolean(v))}
            />
            <span>
              Close system access immediately — removes every role assignment and deactivates the sign-in
              account. The employment record and its history are kept.
              {hasAccount ? "" : " This person has no linked sign-in account."}
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button
            disabled={offboard.isPending}
            onClick={() =>
              offboard.mutate(
                {
                  employeeId: String(employee["id"]),
                  lastWorkingDay: lastDay || null,
                  separationType: type,
                  reason: reason || null,
                  revokeAccess: hasAccount && revoke,
                },
                { onSuccess: () => setOpen(false) },
              )
            }
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
