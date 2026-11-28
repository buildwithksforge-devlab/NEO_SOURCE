import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/branch-filter", () => ({ useActivePropertyFilter: vi.fn() }));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: vi.fn() }));

import {
  validateOpenVolumeDispatch,
  verifyOpenVolumeTransferResult,
} from "@/lib/open-volume-transfers";

const valid = {
  stockItemId: "item",
  fromLocationId: "source",
  toLocationId: "destination",
  volumeMl: 450,
  containerCount: 1,
  attempt: "attempt",
  reason: "Department transfer",
};

describe("measured open-volume transfers", () => {
  it("accepts positive measured stock", () => {
    expect(() => validateOpenVolumeDispatch(valid)).not.toThrow();
  });

  it("rejects same-store dispatch", () => {
    expect(() =>
      validateOpenVolumeDispatch({ ...valid, toLocationId: "source" }),
    ).toThrow();
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid volume %s", (volumeMl) => {
    expect(() =>
      validateOpenVolumeDispatch({ ...valid, volumeMl }),
    ).toThrow();
  });

  it.each([0, -1, 0.5, Infinity])("rejects invalid count %s", (containerCount) => {
    expect(() =>
      validateOpenVolumeDispatch({ ...valid, containerCount }),
    ).toThrow();
  });

  it("requires a durable attempt identity", () => {
    expect(() =>
      validateOpenVolumeDispatch({ ...valid, attempt: "" }),
    ).toThrow();
  });

  it("requires a transfer reason", () => {
    expect(() =>
      validateOpenVolumeDispatch({ ...valid, reason: " " }),
    ).toThrow();
  });

  it("rejects an unconfirmed response", () => {
    expect(() => verifyOpenVolumeTransferResult(null)).toThrow();
    expect(() => verifyOpenVolumeTransferResult({ ok: false })).toThrow();
  });

  it("rejects a different saved transfer", () => {
    expect(() =>
      verifyOpenVolumeTransferResult(
        { ok: true, transfer_id: "other", status: "received" },
        "expected",
        "received",
      ),
    ).toThrow();
  });

  it("rejects a conflicting final state", () => {
    expect(() =>
      verifyOpenVolumeTransferResult(
        { ok: true, transfer_id: "transfer", status: "cancelled" },
        "transfer",
        "received",
      ),
    ).toThrow();
  });

  it("accepts an idempotent confirmed receipt", () => {
    expect(
      verifyOpenVolumeTransferResult(
        {
          ok: true,
          transfer_id: "transfer",
          status: "received",
          replayed: true,
        },
        "transfer",
        "received",
      )["replayed"],
    ).toBe(true);
  });
});