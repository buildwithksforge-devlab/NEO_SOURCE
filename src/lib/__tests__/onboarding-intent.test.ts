/**
 * File-understanding contract.
 *
 * The defect this guards: a hotel selects a foundation data type (categories)
 * and uploads the operational register that merely mentions those categories.
 * NEØ must recognise the mismatch, say so, and offer safe choices — never
 * switch data type on its own and never import the wrong records.
 *
 * Synthetic fixtures only; no real property's workbook appears here.
 */
import { describe, expect, it } from "vitest";
import { domainByKey } from "@/lib/onboarding/domains";
import { classifyFile, extractUniqueValues, fitDomain } from "@/lib/onboarding/intent";

const assetCategories = domainByKey("asset_categories")!;
const assets = domainByKey("assets")!;

const registerHeaders = [
  "Asset Name",
  "Asset Tag",
  "Serial Number",
  "Category",
  "Department",
  "Purchase Date",
  "Purchase Cost",
  "Condition",
  "Status",
];

const registerRows = [
  { "Asset Name": "Chest Freezer", Category: "Kitchen Equipment", Department: "Food & Beverage" },
  { "Asset Name": "Smart Television", Category: "Guest Room Electronics", Department: "Housekeeping" },
  { "Asset Name": "Ice Machine", Category: "Kitchen Equipment", Department: "Food & Beverage" },
  { "Asset Name": "Trolley", Category: "", Department: "Housekeeping" },
];

describe("file understanding", () => {
  it("recognises an operational register uploaded against a foundation type", () => {
    const intent = classifyFile(assetCategories, registerHeaders, registerRows);
    expect(intent.verdict).toBe("other_domain");
    expect(intent.best.domainKey).toBe("assets");
    expect(intent.headline).toMatch(/assets/i);
  });

  it("never switches data type on its own — it only offers the choice", () => {
    const intent = classifyFile(assetCategories, registerHeaders, registerRows);
    expect(intent.selected.domainKey).toBe("asset_categories");
    const kinds = intent.options.map((o) => o.kind);
    expect(kinds).toContain("switch_domain");
    expect(kinds).toContain("continue");
    expect(kinds).toContain("cancel");
    expect(intent.options.filter((o) => o.recommended).length).toBeGreaterThan(0);
  });

  it("offers to lift the distinct foundation values out of the register", () => {
    const intent = classifyFile(assetCategories, registerHeaders, registerRows);
    const extract = intent.options.find((o) => o.kind === "extract_values");
    expect(extract).toBeTruthy();
    expect(extract!.recommended).toBe(true);
  });

  it("accepts a file that genuinely matches the chosen type", () => {
    const intent = classifyFile(assets, registerHeaders, registerRows);
    expect(intent.verdict).not.toBe("other_domain");
    expect(intent.selected.requiredMissing).not.toContain("name");
  });

  it("scores coverage from the columns, not from a hard-coded list", () => {
    const fit = fitDomain(assets, registerHeaders);
    expect(fit.matchedColumns.length).toBeGreaterThanOrEqual(6);
    expect(fit.columnCoverage).toBeGreaterThan(0.6);
    expect(new Set(fit.matchedColumns.map((m) => m.fieldKey)).size).toBe(fit.matchedColumns.length);
  });

  it("deduplicates extracted values and reports the rows that carried none", () => {
    const { values, blankRows } = extractUniqueValues(registerRows, "Category");
    expect(values.map((v) => v.value)).toEqual(["Kitchen Equipment", "Guest Room Electronics"]);
    expect(values[0]!.occurrences).toBe(2);
    expect(values[0]!.sourceRows).toEqual([1, 3]);
    expect(blankRows).toEqual([4]);
  });
});
