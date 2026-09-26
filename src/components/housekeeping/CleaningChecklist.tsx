/**
 * The hotel's own cleaning standard, as it applied to one room clean.
 *
 * Every cleaning job carries a frozen copy of the configured checklist, so a
 * later edit to the standard never rewrites what an attendant was asked to do.
 * This module reads that copy, renders it as a practical mobile-first list and
 * states plainly which required steps are still outstanding. The same rule is
 * enforced again in the database, so this is guidance, not the gate.
 */
import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
          | "cleaning"
          | "inspection"
          | "both",
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

const OPTIONS: { value: string; label: string }[] = [
  { value: "done", label: "Done" },
  { value: "issue", label: "Issue" },
  { value: "not-applicable", label: "N/A" },
];

/** The attendant's execution list for one room. */
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
  const steps = cleaningLines(lines);
  if (steps.length === 0) return <>{emptyState ?? null}</>;

  return (
    <ul className="divide-y divide-border">
      {steps.map((line) => {
        const entry = entries[line.label] ?? { result: null, comment: "" };
        const needsComment =
          Boolean(entry.result && ["not-applicable", "issue"].includes(entry.result)) ||
          line.requiresComment;
        return (
          <li key={line.label} className="py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {line.label}
                  {line.mandatory ? <span className="ml-1 text-destructive">*</span> : null}
                </p>
                {line.instructions ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{line.instructions}</p>
                ) : null}
              </div>
              <div data-action-cluster className="flex shrink-0 gap-1">
                {OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    size="sm"
                    variant={entry.result === option.value ? "default" : "outline"}
                    className={cn("min-w-[4.25rem]")}
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
            </div>
            {needsComment ? (
              <div className="mt-2 space-y-1">
                <Label htmlFor={`note-${line.label}`} className="text-xs">
                  {entry.result === "not-applicable"
                    ? "Why is this step not applicable?"
                    : entry.result === "issue"
                      ? "What is the issue?"
                      : "Note"}
                </Label>
                <Textarea
                  id={`note-${line.label}`}
                  rows={2}
                  value={entry.comment}
                  onChange={(e) => onChange(line.label, { result: entry.result, comment: e.target.value })}
                />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
