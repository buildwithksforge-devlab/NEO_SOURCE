import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSchemaMismatch,
  onQueryError,
  reportQueryError,
  resetQueryTelemetry,
} from "@/lib/query-telemetry";

afterEach(() => {
  resetQueryTelemetry();
  vi.restoreAllMocks();
});

describe("query telemetry", () => {
  it("classifies broken PostgREST selects as schema mismatches", () => {
    expect(isSchemaMismatch({ code: "42703", message: 'column stock_items.unit does not exist' })).toBe(true);
    expect(isSchemaMismatch({ code: "PGRST204", message: "Could not find the 'unit' column" })).toBe(true);
    expect(isSchemaMismatch({ code: "PGRST301", message: "JWT expired" })).toBe(false);
    expect(isSchemaMismatch(null)).toBe(false);
  });

  it("logs once per distinct failure and notifies alert sinks", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = vi.fn();
    onQueryError(sink);

    reportQueryError("inventory.stock_items", { code: "42703", message: "boom" });
    reportQueryError("inventory.stock_items", { code: "42703", message: "boom" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      context: "inventory.stock_items",
      schemaMismatch: true,
    });
  });

  it("never lets a broken alert sink escape into the query path", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    onQueryError(() => {
      throw new Error("sink down");
    });
    expect(() => reportQueryError("notifications.unread-count", { message: "x" })).not.toThrow();
  });

  it("is wired into the inventory and notification query surfaces", () => {
    const wired = [
      ["src/lib/fnb.ts", "inventory.stock_items"],
      ["src/lib/dashboard-data.ts", "notifications.dashboard"],
      ["src/lib/notifications-inbox.ts", "notifications.unread-count"],
    ] as const;
    for (const [file, context] of wired) {
      const source = readFileSync(file, "utf8");
      expect(source).toContain(`reportQueryError("${context}"`);
    }
  });
});

describe("F&B stock picker fallback", () => {
  it("retries with a minimal projection and flags the degraded catalogue", () => {
    const source = readFileSync("src/lib/fnb.ts", "utf8");
    expect(source).toContain('db.from("stock_items").select("id, name")');
    expect(source).toContain("rows.degraded = true");
    expect(source).toContain("export function isDegradedStockItems");
  });

  it.each([
    "src/routes/_shell.bar.requisitions.tsx",
    "src/routes/_shell.delivery.requisitions.tsx",
    "src/routes/_shell.housekeeping.requisitions.tsx",
    "src/routes/_shell.pms.requisitions.tsx",
    "src/routes/_shell.pos.requisitions.tsx",
  ])("%s renders the recovery notice", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).toContain("<StockItemNotice query=");
  });
});
