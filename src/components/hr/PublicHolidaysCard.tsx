import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { EmptyState, QueryState } from "@/components/hr/HrShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useHrWrite } from "@/lib/hr-data";
import { usePublicHolidays } from "@/lib/hr-leave";
import { HR_MODULES, shortDate, type Row } from "@/lib/hr";

/**
 * Public holidays are never invented: they are entered here with real dates and
 * only then excluded from leave day counting by the policies that ask for it.
 *
 * The table is year-aware. A holiday entered for a future year is shown
 * immediately by moving the view to that year, instead of silently dropping out
 * of a current-year-only list.
 */
export function PublicHolidaysCard() {
  const { can } = useAuth();
  const thisYear = new Date().getFullYear();
  const [view, setView] = useState<string>(String(thisYear));
  const holidays = usePublicHolidays(view === "all" ? "all" : Number(view));
  const write = useHrWrite("public_holidays", { module: HR_MODULES.leave });
  const manage = can(HR_MODULES.leave, "types.manage");
  const [name, setName] = useState("");
  const [date, setDate] = useState("");

  const years = useMemo(() => {
    const set = new Set<number>([thisYear - 1, thisYear, thisYear + 1]);
    if (date) set.add(Number(date.slice(0, 4)));
    return [...set].filter((y) => Number.isFinite(y)).sort((a, b) => a - b);
  }, [thisYear, date]);

  async function add() {
    if (!name.trim() || !date) return;
    try {
      await write.mutateAsync({ values: { name: name.trim(), holiday_date: date } });
      // Show the year the holiday actually belongs to, so it is visibly saved.
      setView(date.slice(0, 4));
      setName("");
      setDate("");
      toast.success("Public holiday added");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add the holiday";
      toast.error(
        /duplicate key|unique/i.test(message)
          ? "That date is already recorded as a public holiday"
          : message,
      );
    }
  }

  async function setObserved(row: Row, observed: boolean) {
    try {
      await write.mutateAsync({ id: String(row["id"]), values: { observed } });
      toast.success(observed ? "Holiday marked as observed" : "Holiday marked as not observed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the holiday");
    }
  }

  return (
    <SectionCard
      title="Public holidays"
      description="Enter the real gazetted dates. Leave types set to exclude public holidays will skip them when counting days, in any year."
      actions={
        <Select value={view} onValueChange={setView}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
            <SelectItem value="all">All years</SelectItem>
          </SelectContent>
        </Select>
      }
    >
      {manage ? (
        <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="holiday-name">Holiday name</Label>
            <Input
              id="holiday-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Name as gazetted"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Date</Label>
            <NeoDatePicker value={date} onChange={setDate} />
          </div>
          <Button onClick={() => void add()} disabled={!name.trim() || !date || write.isPending}>
            <Plus className="mr-2 size-4" aria-hidden />
            Add
          </Button>
        </div>
      ) : null}

      <QueryState
        isLoading={holidays.isLoading}
        error={holidays.error}
        isEmpty={(holidays.data ?? []).length === 0}
        empty={
          <EmptyState
            title={
              view === "all"
                ? "No public holidays configured"
                : `No public holidays recorded for ${view}`
            }
            description="Until real dates are entered, every calendar day is counted according to each leave policy's weekend rule. Switch the year above to see dates recorded for another year."
          />
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Holiday</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Observed</TableHead>
                {manage ? <TableHead className="w-16" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {(holidays.data ?? []).map((h) => (
                <TableRow key={String(h["id"])}>
                  <TableCell className="font-medium">{String(h["name"])}</TableCell>
                  <TableCell>{shortDate(h["holiday_date"])}</TableCell>
                  <TableCell>{h["observed"] === false ? "Not observed" : "Observed"}</TableCell>
                  {manage ? (
                    <TableCell>
                      {h["observed"] === false ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Mark as observed"
                          onClick={() => void setObserved(h, true)}
                        >
                          <RotateCcw className="size-4" aria-hidden />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Mark as not observed"
                          onClick={() => void setObserved(h, false)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      )}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </QueryState>
    </SectionCard>
  );
}
