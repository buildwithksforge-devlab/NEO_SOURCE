import { describe, expect, it } from "vitest";
import {
  productionYield,
  productionIsExpired,
  productionCanBeMadeAvailable,
} from "../production-yield";

describe("actual production measurement", () => {
  it("supports changing fruit yields across batches", () => {
    const first = productionYield({
      planned: 3, gross: 2.8, waste: 0,
    });
    const second = productionYield({
      planned: 3, gross: 3.2, waste: 0,
    });

    expect(first.available).toBe(2.8);
    expect(second.available).toBe(3.2);
  });

  it("subtracts production waste from gross output", () => {
    const result = productionYield({
      planned: 4, gross: 4.5, waste: 0.5,
    });

    expect(result.available).toBe(4);
    expect(result.yieldPercent).toBe(100);
  });

  it("supports below-plan yields", () => {
    expect(productionYield({
      planned: 5, gross: 4, waste: 0,
    }).variance).toBe(-1);
  });

  it("supports above-plan yields", () => {
    expect(productionYield({
      planned: 5, gross: 6, waste: 0,
    }).variance).toBe(1);
  });

  it("calculates waste percentage", () => {
    expect(productionYield({
      planned: 5, gross: 5, waste: 1,
    }).wastePercent).toBe(20);
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects nonfinite quantities: %s",
    (quantity) => {
      expect(() => productionYield({
        planned: 5, gross: quantity, waste: 0,
      })).toThrow();
    },
  );

  it("rejects waste exceeding output", () => {
    expect(() => productionYield({
      planned: 5, gross: 4, waste: 5,
    })).toThrow();
  });

  it("rejects negative waste", () => {
    expect(() => productionYield({
      planned: 5, gross: 4, waste: -1,
    })).toThrow();
  });

  it("rejects zero planned production", () => {
    expect(() => productionYield({
      planned: 0, gross: 4, waste: 0,
    })).toThrow();
  });

  it("does not make an already posted batch available twice", () => {
    expect(productionCanBeMadeAvailable({
      posted: true, planned: 5, gross: 5,
      waste: 0, now: 100,
    })).toBe(false);
  });

  it("rejects production with no usable output", () => {
    expect(productionCanBeMadeAvailable({
      posted: false, planned: 5, gross: 5,
      waste: 5, now: 100,
    })).toBe(false);
  });

  it("permits valid unposted production", () => {
    expect(productionCanBeMadeAvailable({
      posted: false, planned: 5, gross: 4,
      waste: 1, now: 100,
    })).toBe(true);
  });

  it("rejects expired production", () => {
    expect(productionCanBeMadeAvailable({
      posted: false, planned: 5, gross: 4,
      waste: 1, useBy: "2026-11-27T12:00:00Z",
      now: Date.parse("2026-11-28T12:00:00Z"),
    })).toBe(false);
  });

  it("rejects malformed expiry dates", () => {
    expect(productionIsExpired("invalid",100)).toBe(true);
  });

  it("supports production without configured expiry", () => {
    expect(productionIsExpired(null,100)).toBe(false);
  });
});
