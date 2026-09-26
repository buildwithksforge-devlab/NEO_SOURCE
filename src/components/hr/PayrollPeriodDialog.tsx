import { useState } from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/common/FormDialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { useHrWrite } from "@/lib/hr-data";
import type { Row } from "@/lib/hr";

/**
 * Create a payroll period.
 *
 * A period is only a window with a name and dates — no salary, tax or
 * deduction figure is invented here. Inputs are built from approved
 * attendance afterwards, and the period can then be locked.
 */
export function PayrollPeriodDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const write = useHrWrite("payroll_periods", { action: "hr.payroll.period_created" });
  const [name, setName] = useState("");
  const [start, setStart] = useState<string>("");
  const [end, setEnd] = useState<string>("");

  const reset = () => {
    setName("");
    setStart("");
    setEnd("");
  };

  const canSubmit = name.trim().length > 0 && Boolean(start) && Boolean(end) && start <= end;

  const submit = () => {
    write.mutate(
      {
        values: {
          name: name.trim(),
          period_start: start,
          period_end: end,
          status: "draft",
        } as Row,
      },
      {
        onSuccess: () => {
          toast.success("Payroll period created");
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
      title="New payroll period"
      description="Name the period and set the dates it covers."
      submitLabel="Create period"
      canSubmit={canSubmit && !write.isPending}
      busy={write.isPending}
      onSubmit={submit}
      footerNote="No pay figures are entered here — inputs come from approved attendance and leave."
      size="md"
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="payroll-period-name">Period name</Label>
          <Input
            id="payroll-period-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="September 2026"
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Period start</Label>
            <NeoDatePicker value={start} onChange={(v) => setStart(v ?? "")} />
          </div>
          <div className="space-y-2">
            <Label>Period end</Label>
            <NeoDatePicker value={end} onChange={(v) => setEnd(v ?? "")} />
          </div>
        </div>
      </div>
    </FormDialog>
  );
}
