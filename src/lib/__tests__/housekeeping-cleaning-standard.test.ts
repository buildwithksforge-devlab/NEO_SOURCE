/**
 * The hotel's cleaning standard is only real if it is enforced.
 *
 * These checks hold the attendant-side rules: the frozen copy is read in the
 * order the hotel configured, required steps block handover until they are
 * recorded, "issue" and "not applicable" demand a reason, and only cleaning
 * steps — never inspection-only steps — are asked of the attendant.
 */
import { describe, expect, it } from "vitest";

import {
  checklistResultRows,
  cleaningLines,
  inspectionLines,
  outstandingRequired,
  parseChecklistSnapshot,
  type ChecklistEntry,
} from "@/components/housekeeping/CleaningChecklist";

const snapshot = [
  { item_id: "b", label: "Bathroom", applies_to: "both", mandatory: true, sort_order: 20 },
  { item_id: "a", label: "Strip the bed", applies_to: "cleaning", mandatory: true, sort_order: 10 },
  { item_id: "c", label: "Linen quality", applies_to: "inspection", mandatory: true, sort_order: 30 },
  {
    item_id: "d",
    label: "Minibar",
    applies_to: "cleaning",
    mandatory: false,
    requires_comment: true,
    sort_order: 40,
  },
];

const entries = (o: Record<string, ChecklistEntry>) => o;

describe("cleaning standard snapshot", () => {
  it("reads the frozen copy in the configured order", () => {
    expect(parseChecklistSnapshot(snapshot).map((l) => l.label)).toEqual([
      "Strip the bed",
      "Bathroom",
      "Linen quality",
      "Minibar",
    ]);
  });

  it("returns nothing when no standard was configured", () => {
    expect(parseChecklistSnapshot(null)).toEqual([]);
    expect(parseChecklistSnapshot([])).toEqual([]);
  });

  it("splits cleaning steps from inspection-only steps", () => {
    const lines = parseChecklistSnapshot(snapshot);
    expect(cleaningLines(lines).map((l) => l.label)).toEqual([
      "Strip the bed",
      "Bathroom",
      "Minibar",
    ]);
    expect(inspectionLines(lines).map((l) => l.label)).toEqual(["Bathroom", "Linen quality"]);
  });
});

describe("required steps", () => {
  const lines = parseChecklistSnapshot(snapshot);

  it("blocks handover while a required step is unrecorded", () => {
    expect(outstandingRequired(lines, entries({}))).toEqual(["Strip the bed", "Bathroom"]);
  });

  it("never asks the attendant for an inspection-only step", () => {
    expect(outstandingRequired(lines, entries({}))).not.toContain("Linen quality");
  });

  it("demands a reason for an issue or a skipped step", () => {
    const partial = entries({
      "Strip the bed": { result: "done", comment: "" },
      Bathroom: { result: "issue", comment: "" },
    });
    expect(outstandingRequired(lines, partial)).toEqual(["Bathroom"]);
    partial["Bathroom"] = { result: "issue", comment: "Cracked tile" };
    expect(outstandingRequired(lines, partial)).toEqual([]);
  });

  it("clears once every required step carries a result", () => {
    const done = entries({
      "Strip the bed": { result: "done", comment: "" },
      Bathroom: { result: "done", comment: "" },
    });
    expect(outstandingRequired(lines, done)).toEqual([]);
  });
});

describe("recorded evidence", () => {
  const lines = parseChecklistSnapshot(snapshot);

  it("records only what the attendant answered, flagged and scoped to the job", () => {
    const rows = checklistResultRows(
      "job-1",
      "org-1",
      lines,
      entries({
        "Strip the bed": { result: "done", comment: "" },
        Bathroom: { result: "issue", comment: "Cracked tile" },
        "Linen quality": { result: "done", comment: "" },
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ job_id: "job-1", organization_id: "org-1", result: "done" });
    expect(rows[1]).toMatchObject({
      label: "Bathroom",
      comment: "Cracked tile",
      defect_reported: true,
    });
  });
});
