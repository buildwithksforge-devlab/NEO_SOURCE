import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/lib/hr-data.ts"), "utf8");

function selectFor(table: string) {
  const idx = source.indexOf(`"${table}",`);
  expect(idx, `${table} query not found`).toBeGreaterThan(-1);
  return source.slice(idx, idx + 400);
}

describe("HR leave queries", () => {
  it("qualifies the leave_requests → employees embed by constraint name", () => {
    const block = selectFor("leave_requests");
    expect(block).toContain("employees!leave_requests_employee_id_fkey");
  });

  it("never uses a bare employees(...) embed on leave_requests", () => {
    const block = selectFor("leave_requests");
    expect(/[^!]employees\(/.test(block.replace("employees:employees!", ""))).toBe(false);
  });

  it("keeps the leave type and department embeds intact", () => {
    const block = selectFor("leave_requests");
    expect(block).toContain("leave_types(name, code, paid, medical_sensitive)");
    expect(block).toContain("departments(name)");
  });
});
