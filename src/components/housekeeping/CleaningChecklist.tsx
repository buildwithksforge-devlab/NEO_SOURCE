/**
 * The hotel's own cleaning standard, as it applied to one room clean.
 *
 * Every cleaning job carries a frozen copy of the configured checklist, so a
 * later edit to the standard never rewrites what an attendant was asked to do.
 * This module reads that copy, renders it as a practical mobile-first list and
 * states plainly which required steps are still outstanding. The same rule is
 * enforced again in the database, so this is guidance, not the gate.
 */
import { useId, type ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

export type ChecklistLine = {
  itemId: string | null;
  label: string;
  instructions: string | null;
  appliesTo: "cleaning" | "inspection" | "both";
  mandatory: boolean;
  requiresComment: boolean;
  requiresPhoto: boolean;
  allowsDefect: boolean;
  sortOrder: number;
};

export type ChecklistEntry = { result: string | null; comment: string };

/** Reads the frozen checklist copy stored on a cleaning job. */
export function parseChecklistSnapshot(value: unknown): ChecklistLine[] {
  if (!Array.isArray(value)) return [];
  const lines = value
    .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object")
    .map((raw) => {
      const scope = String(raw["applies_to"] ?? "cleaning");
      return {
        itemId: raw["item_id"] ? String(raw["item_id"]) : null,
        label: String(raw["label"] ?? "").trim(),
        instructions: raw["instructions"] ? String(raw["instructions"]) : null,
        appliesTo: (scope === "inspection" || scope === "both" ? scope : "cleaning") as
          "cleaning" | "inspection" | "both",
        mandatory: Boolean(raw["mandatory"]),
        requiresComment: Boolean(raw["requires_comment"]),
        requiresPhoto: Boolean(raw["requires_photo"]),
        allowsDefect: Boolean(raw["allows_defect"]),
        sortOrder: Number(raw["sort_order"] ?? 0),
      } satisfies ChecklistLine;
    })
    .filter((l) => l.label.length > 0);
  return lines.sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

export const cleaningLines = (lines: ChecklistLine[]) =>
  lines.filter((l) => l.appliesTo === "cleaning" || l.appliesTo === "both");

export const inspectionLines = (lines: ChecklistLine[]) =>
  lines.filter((l) => l.appliesTo === "inspection" || l.appliesTo === "both");

/** Required steps still outstanding — the same rule the database enforces. */
export function outstandingRequired(
  lines: ChecklistLine[],
  entries: Record<string, ChecklistEntry>,
): string[] {
  return cleaningLines(lines)
    .filter((line) => {
      if (!line.mandatory) return false;
      const entry = entries[line.label];
      const result = entry?.result ?? null;
      if (!result) return true;
      const comment = (entry?.comment ?? "").trim();
      if (["not-applicable", "failed", "issue"].includes(result) && !comment) return true;
      if (line.requiresComment && !comment) return true;
      return false;
    })
    .map((line) => line.label);
}

/** Rows ready for `housekeeping_job_results`. */
export function checklistResultRows(
  jobId: string,
  organizationId: string | null,
  lines: ChecklistLine[],
  entries: Record<string, ChecklistEntry>,
): Record<string, unknown>[] {
  return cleaningLines(lines)
    .filter((line) => entries[line.label]?.result)
    .map((line) => ({
      job_id: jobId,
      label: line.label,
      result: entries[line.label]!.result,
      comment: (entries[line.label]!.comment || "").trim() || null,
      defect_reported: entries[line.label]!.result === "issue",
      ...(line.itemId ? { checklist_item_id: line.itemId } : {}),
      ...(organizationId ? { organization_id: organizationId } : {}),
    }));
}

/** The attendant's execution list; saved result values and validation stay canonical. */
export function CleaningChecklistForm({
  lines,
  entries,
  onChange,
  emptyState,
}: {
  lines: ChecklistLine[];
  entries: Record<string, ChecklistEntry>;
  onChange: (label: string, entry: ChecklistEntry) => void;
  emptyState?: ReactNode;
}) {
  const formId = useId();
  const steps = cleaningLines(lines);
  if (steps.length === 0) return <>{emptyState ?? null}</>;
  const recorded = steps.filter((line) => entries[line.label]?.result).length;
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {recorded} of {steps.length} steps recorded
      </p>
      <div
        role="region"
        aria-label="Cleaning checklist steps"
        tabIndex={0}
        className="min-h-0 max-h-[50dvh] overflow-y-auto overscroll-contain rounded-md border px-3 [scrollbar-gutter:stable] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ul className="min-w-0 divide-y divide-border">
          {steps.map((line, index) => {
            const entry = entries[line.label] ?? { result: null, comment: "" };
            const itemId = `${formId}-${index}`;
            const needsComment =
              Boolean(entry.result && ["not-applicable", "issue"].includes(entry.result)) ||
              line.requiresComment;
            return (
              <li key={line.label} className="min-w-0 space-y-2 py-3">
                <label
                  htmlFor={itemId}
                  className="flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-md py-1"
                >
                  <Checkbox
                    id={itemId}
                    checked={entry.result === "done"}
                    className="mt-0.5 size-6 shrink-0"
                    onCheckedChange={(checked) =>
                      onChange(line.label, {
                        result: checked === true ? "done" : null,
                        comment: entry.comment,
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">
                    <span className="text-sm font-medium">
                      {line.label}
                      {line.mandatory ? (
                        <span className="ml-1 text-destructive" aria-label="required">
                          *
                        </span>
                      ) : null}
                    </span>
                    {line.instructions ? (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {line.instructions}
                      </span>
                    ) : null}
                  </span>
                </label>
                <div
                  className="flex min-w-0 flex-wrap gap-2 pl-9"
                  role="group"
                  aria-label={`Exceptions for ${line.label}`}
                >
                  {[
                    { value: "issue", label: "Issue" },
                    { value: "not-applicable", label: "N/A" },
                  ].map((option) => (
                    <Button
                      key={option.value}
                      type="button"
                      size="sm"
                      className="min-h-11"
                      aria-label={`${option.label}: ${line.label}`}
                      aria-pressed={entry.result === option.value}
                      variant={entry.result === option.value ? "default" : "outline"}
                      onClick={() =>
                        onChange(line.label, {
                          result: entry.result === option.value ? null : option.value,
                          comment: entry.comment,
                        })
                      }
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
                {needsComment ? (
                  <div className="min-w-0 space-y-1 pl-9">
                    <Label htmlFor={`${itemId}-note`} className="text-xs">
                      {entry.result === "not-applicable"
                        ? "Why is this step not applicable?"
                        : entry.result === "issue"
                          ? "What is the issue?"
                          : "Note"}
                    </Label>
                    <Textarea
                      id={`${itemId}-note`}
                      rows={2}
                      className="min-w-0"
                      value={entry.comment}
                      onChange={(event) =>
                        onChange(line.label, { result: entry.result, comment: event.target.value })
                      }
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
