import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, HrBadge, QueryState } from "@/components/hr/HrShared";
import { useHrWrite } from "@/lib/hr-data";
import { useAuth } from "@/lib/auth";
import { HR_MODULES, shortDate, titleCase, type Row } from "@/lib/hr";

const CHECKS = [
  { key: "assets_cleared", label: "Company property returned" },
  { key: "finance_cleared", label: "Finance cleared (dues and advances settled)" },
  { key: "it_access_revoked", label: "System and building access revoked" },
  { key: "documents_issued", label: "Exit documents issued" },
] as const;

/**
 * Works an open exit clearance: the checklist, interview notes and the final
 * completion. Nothing is ticked on the employee's behalf — each item is a
 * deliberate action by the HR user, and completion is only offered once every
 * item is confirmed.
 */
export function ExitClearancePanel({
  query,
}: {
  query: { data: Row[] | undefined; isLoading: boolean; error: unknown };
}) {
  const { can } = useAuth();
  const mayEdit = can(HR_MODULES.employees, "edit") || can(HR_MODULES.employees, "terminate");
  const write = useHrWrite("employee_exit_clearances", { action: "hr.exit.clearance_updated" });
  const record = (query.data ?? [])[0];
  const [notes, setNotes] = useState<string | null>(null);

  const noteValue = notes ?? (record ? String(record["exit_interview_notes"] ?? "") : "");
  const allCleared = useMemo(
    () => (record ? CHECKS.every((c) => Boolean(record[c.key])) : false),
    [record],
  );
  const completed = record ? String(record["status"]) === "completed" : false;

  const patch = (values: Record<string, unknown>, message: string) => {
    if (!record) return;
    write.mutate(
      { id: String(record["id"]), values: values as Row },
      { onSuccess: () => toast.success(message) },
    );
  };

  return (
    <QueryState
      isLoading={query.isLoading}
      error={query.error}
      isEmpty={!record}
      empty={
        <EmptyState
          title="No exit recorded"
          description="A clearance opens automatically when employment is ended."
        />
      }
    >
      {record ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span>{titleCase(record["separation_type"])}</span>
            <span>Notice {shortDate(record["notice_date"])}</span>
            <span>Last working day {shortDate(record["last_working_day"])}</span>
            <HrBadge
              value={titleCase(record["status"])}
              tone={completed ? "success" : "warning"}
            />
          </div>

          <div className="space-y-3">
            {CHECKS.map((c) => (
              <label key={c.key} className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={Boolean(record[c.key])}
                  disabled={!mayEdit || completed || write.isPending}
                  onCheckedChange={(v) =>
                    patch({ [c.key]: Boolean(v) }, `${c.label} updated`)
                  }
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>

          <div className="space-y-2">
            <Label htmlFor="exit-notes">Exit interview notes</Label>
            <Textarea
              id="exit-notes"
              value={noteValue}
              disabled={!mayEdit || completed}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What the leaver said, in their words."
            />
            {mayEdit && !completed ? (
              <Button
                variant="outline"
                size="sm"
                disabled={write.isPending || notes === null}
                onClick={() => patch({ exit_interview_notes: noteValue }, "Notes saved")}
              >
                Save notes
              </Button>
            ) : null}
          </div>

          {mayEdit && !completed ? (
            <div className="space-y-2 border-t pt-4">
              <Button
                disabled={!allCleared || write.isPending}
                onClick={() =>
                  patch(
                    { status: "completed", completed_at: new Date().toISOString() },
                    "Clearance completed",
                  )
                }
              >
                Complete clearance
              </Button>
              {!allCleared ? (
                <p className="text-xs text-muted-foreground">
                  Every item above must be confirmed before the clearance can be completed.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </QueryState>
  );
}
