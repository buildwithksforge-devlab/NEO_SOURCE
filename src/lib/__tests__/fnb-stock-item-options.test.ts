import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("F&B stock item options", () => {
  it("selects canonical stock item unit and category fields", () => {
    const source = readFileSync("src/lib/fnb.ts", "utf8");

    expect(source).toContain('select("id, name, base_unit, category_id")');
    expect(source).not.toContain('select("id, name, unit, category")');
  });

  it.each([
    "src/routes/_shell.bar.requisitions.tsx",
    "src/routes/_shell.delivery.requisitions.tsx",
    "src/routes/_shell.housekeeping.requisitions.tsx",
    "src/routes/_shell.pms.requisitions.tsx",
    "src/routes/_shell.pos.requisitions.tsx",
  ])("%s maps selected stock items through base_unit", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain('["base_unit"]');
  });
});