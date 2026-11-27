import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/branch-filter", () => ({ useActivePropertyFilter: vi.fn() }));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: vi.fn() }));

import {
  verifyPrinterAssignment,
} from "@/lib/production-printer-assignments";

describe("shared production printer configuration", () => {
  it("accepts confirmed assignments independent of ordering", () => {
    expect(
      verifyPrinterAssignment(
        {
          ok: true,
          printer_id: "printer",
          station_ids: ["coffee", "bar"],
        },
        "printer",
        ["bar", "coffee"],
      ),
    ).toEqual(["bar", "coffee"]);
  });

  it("allows clearing additional assignments", () => {
    expect(
      verifyPrinterAssignment(
        {
          ok: true,
          printer_id: "printer",
          station_ids: [],
        },
        "printer",
        [],
      ),
    ).toEqual([]);
  });

  it("rejects a different printer", () => {
    expect(() =>
      verifyPrinterAssignment(
        {
          ok: true,
          printer_id: "another-printer",
          station_ids: ["bar"],
        },
        "printer",
        ["bar"],
      ),
    ).toThrow();
  });

  it("rejects missing saved assignments", () => {
    expect(() =>
      verifyPrinterAssignment(
        {
          ok: true,
          printer_id: "printer",
          station_ids: ["bar"],
        },
        "printer",
        ["bar", "coffee"],
      ),
    ).toThrow();
  });

  it("rejects unexpected additional stations", () => {
    expect(() =>
      verifyPrinterAssignment(
        {
          ok: true,
          printer_id: "printer",
          station_ids: ["bar", "kitchen"],
        },
        "printer",
        ["bar"],
      ),
    ).toThrow();
  });

  it("rejects an unconfirmed configuration", () => {
    expect(() =>
      verifyPrinterAssignment(
        { ok: false },
        "printer",
        ["bar"],
      ),
    ).toThrow();
  });
});