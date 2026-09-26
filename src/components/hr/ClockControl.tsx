import { Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useClockIn, useClockOut, useMyEmployee, useMyOpenShift } from "@/lib/hr-data";
import { clockTime, type Row } from "@/lib/hr";

/**
 * Clock in and out from wherever the member of staff happens to be.
 *
 * The same attendance record the HR screens read is written here — there is no
 * second store of times. Clocking out sends the record for supervisor review,
 * exactly as it does from My HR, so worked hours and any overtime still pass
 * through the normal check before payroll sees them.
 */
export function ClockControl({ className }: { className?: string }) {
  const me = useMyEmployee();
  const employeeId = me.data?.["id"] as string | undefined;
  const openShift = useMyOpenShift(employeeId);
  const clockIn = useClockIn();
  const clockOut = useClockOut();

  // Staff without an employee record have no attendance to keep.
  if (!me.data) return null;

  const open = openShift.data as Row | null;
  const busy = clockIn.isPending || clockOut.isPending;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant={open ? "default" : "outline"}
          disabled={busy}
          className={"shrink-0 rounded-xl " + (className ?? "")}
          onClick={() =>
            open
              ? clockOut.mutate({ record: open })
              : clockIn.mutate({ employee: me.data as Row, source: "web" })
          }
        >
          <Clock className="mr-1.5 size-4" aria-hidden />
          {open ? "Clock out" : "Clock in"}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {open
          ? `On shift since ${clockTime(open["clock_in_at"])} — clocking out sends the day for supervisor review`
          : "Start today's attendance record"}
      </TooltipContent>
    </Tooltip>
  );
}
