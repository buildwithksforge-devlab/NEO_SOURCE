/**
 * The audit trail is partitioned by month. A read without a date bound cannot be
 * pruned to a partition, so it degrades for ever as history accumulates. This
 * test fails the build when a new audit read forgets its window.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_DEFAULT_WINDOW_DAYS, auditWindowFrom } from "../audit-window";

const ROOT = join(process.cwd(), "src");
const SKIP = ["__tests__", "node_modules", "integrations"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("audit trail query contract", () => {
  it("gives every audit read a date window", () => {
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes('from("audit_logs")')) continue;
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (!line.includes('from("audit_logs")')) return;
        const chain = lines.slice(i, i + 14).join("\n");
        // Writes do not need a window; reads do.
        if (/\.(insert|upsert|update|delete)\(/.test(chain)) return;
        if (!/\.select\(/.test(chain)) return;
        if (/\.(gte|gt|lte|lt|filter)\(\s*["'`]created_at/.test(chain)) return;
        offenders.push(`${file.replace(ROOT, "src")}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("produces a bounded window in the past", () => {
    const now = new Date("2026-09-19T00:00:00.000Z");
    expect(auditWindowFrom(30, now)).toBe("2026-08-20T00:00:00.000Z");
    expect(AUDIT_DEFAULT_WINDOW_DAYS).toBeGreaterThan(0);
    expect(new Date(auditWindowFrom(AUDIT_DEFAULT_WINDOW_DAYS, now)).getTime()).toBeLessThan(now.getTime());
  });
});
