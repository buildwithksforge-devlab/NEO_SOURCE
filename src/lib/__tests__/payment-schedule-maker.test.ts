import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("payment schedule maker identity", () => {
  const source = readFileSync("src/lib/finance-data.ts", "utf8");

  it("requires an authenticated creator", () => {
    expect(source).toContain(
      'table === "payment_schedules" && !ctx.userId'
    );
  });

  it("assigns the authenticated creator to payment schedules", () => {
    expect(source).toContain(
      'table === "payment_schedules" ? { created_by: ctx.userId } : {}'
    );
  });

  it("preserves organization scoping", () => {
    expect(source).toContain("organization_id: ctx.organizationId");
  });
});