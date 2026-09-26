import { describe, expect, it } from "vitest";
import {
  formatMoneyCompact,
  formatMoneyExact,
  moneyDisplay,
} from "@/lib/money-format";

describe("money formatting", () => {
  it("keeps accounting surfaces at full precision", () => {
    expect(formatMoneyExact(128_750_654)).toBe("KES 128,750,654.00");
    expect(formatMoneyExact(-1234.5)).toBe("-KES 1,234.50");
    expect(formatMoneyExact(0)).toBe("KES 0.00");
  });

  it("abbreviates only where the glance is the point", () => {
    expect(formatMoneyCompact(128_750_654)).toBe("KES 128.8M");
    expect(formatMoneyCompact(1_284_000_000)).toBe("KES 1.3B");
    expect(formatMoneyCompact(12_400)).toBe("KES 12.4K");
    expect(formatMoneyCompact(999)).toBe("KES 999");
    expect(formatMoneyCompact(999.5)).toBe("KES 999.50");
    expect(formatMoneyCompact(0)).toBe("KES 0");
  });

  it("handles negatives and other currencies", () => {
    expect(formatMoneyCompact(-2_500_000)).toBe("-KES 2.5M");
    expect(formatMoneyCompact(2_500_000, "USD")).toBe("USD 2.5M");
    expect(formatMoneyExact(2_500_000, "usd")).toBe("USD 2,500,000.00");
  });

  it("is honest about missing figures instead of printing a zero", () => {
    expect(formatMoneyExact(null)).toBe("—");
    expect(formatMoneyCompact(undefined)).toBe("—");
    expect(formatMoneyCompact("not a number")).toBe("—");
  });

  it("always carries the exact amount alongside a compact label", () => {
    const big = moneyDisplay(128_750_654);
    expect(big.label).toBe("KES 128.8M");
    expect(big.exact).toBe("KES 128,750,654.00");
    expect(big.abbreviated).toBe(true);

    const small = moneyDisplay(42);
    expect(small.abbreviated).toBe(true); // "KES 42" vs "KES 42.00"
    expect(small.exact).toBe("KES 42.00");
  });
});
