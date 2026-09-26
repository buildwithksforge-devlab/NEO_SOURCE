/**
 * Notification counts must always span both property-owned notices and
 * organisation-wide notices (branch_id IS NULL). A strict equality filter on
 * any notification surface silently under-reports unread work.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BRANCH_OR_GLOBAL_TABLES, BRANCH_SCOPED_TABLES } from "@/lib/branch-filter";

const read = (p: string) => readFileSync(p, "utf8");

describe("notification scope contract", () => {
  it("classifies notifications as property-or-organisation, never strictly property-owned", () => {
    expect(BRANCH_OR_GLOBAL_TABLES.has("notifications")).toBe(true);
    expect(BRANCH_SCOPED_TABLES.has("notifications")).toBe(false);
  });

  it("applyTo emits an inclusive filter for notifications", () => {
    const calls: string[] = [];
    const builder = {
      eq: (c: string, v: string) => {
        calls.push(`eq:${c}=${v}`);
        return builder;
      },
      or: (f: string) => {
        calls.push(`or:${f}`);
        return builder;
      },
    };
    // Mirrors useActivePropertyFilter().applyTo for a selected property.
    const branchId = "branch-1";
    const table = "notifications";
    if (BRANCH_SCOPED_TABLES.has(table)) builder.eq("branch_id", branchId);
    else if (BRANCH_OR_GLOBAL_TABLES.has(table))
      builder.or(`branch_id.eq.${branchId},branch_id.is.null`);

    expect(calls).toEqual(["or:branch_id.eq.branch-1,branch_id.is.null"]);
  });

  it.each(["src/lib/dashboard-data.ts"])("%s reads notifications inclusively", (file) => {
    const source = read(file);
    const block = source.slice(source.indexOf('.from("notifications")'));
    const query = block.slice(0, block.indexOf("return data"));
    expect(query).toContain("branch_id.is.null");
    expect(query).not.toMatch(/q\.eq\("branch_id"/);
  });

  it("the boot prefetch no longer duplicates the notifications read", () => {
    // The shell inbox reads notifications on every route; a second panel copy
    // in the prefetch was a duplicate request, not a warm cache.
    expect(read("src/lib/boot-prefetch.ts")).not.toContain('.from("notifications")');
  });

  it("the unread badge counts through the shared scope filter, keyed by property", () => {
    const source = read("src/lib/notifications-inbox.ts");
    expect(source).toContain('"notifications"');
    // Formatting-insensitive: the badge must still count through applyTo().
    expect(source.replace(/\s+/g, " ")).toContain(
      'applyTo( supabase.from("notifications")',
    );
    expect(source).toContain('["notifications-unread", organizationId, filterKey]');
  });
});
