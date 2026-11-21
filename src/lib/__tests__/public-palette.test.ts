import { describe, it, expect } from "vitest";
import { colorContrast, primaryInk, accessibleAccent, guestPalette } from "@/lib/public-palette";
describe("published palette contrast", () => {
  it("uses standard contrast ratios", () =>
    expect(colorContrast("#FFFFFF", "#000000")).toBeCloseTo(21));
  it.each(["#18C4C8", "#BFDADD", "#07142D", "#D5AF63", "#FFFFFF", "#777777"])(
    "chooses readable ink without making %s buttons black",
    (fill) => {
      expect(colorContrast(fill, primaryInk(fill))).toBeGreaterThanOrEqual(4.5);
      expect(guestPalette(fill, "#F7F9FC")["--pa-primary"]).toBe(fill.toUpperCase());
    },
  );
  it.each(["#F7F9FC", "#FFFFFF", "#111827", "#172033"])(
    "keeps accent labels readable on %s",
    (ground) => {
      for (const fill of ["#18C4C8", "#BFDADD", "#07142D", "#D5AF63"])
        expect(colorContrast(accessibleAccent(fill, ground), ground)).toBeGreaterThanOrEqual(4.5);
    },
  );
  it("provides distinct light and dark semantic surfaces", () => {
    expect(guestPalette("#18C4C8", "#F7F9FC")["--guest-scheme"]).toBe("light");
    const dark = guestPalette("#18C4C8", "#111827");
    expect(dark["--guest-scheme"]).toBe("dark");
    expect(colorContrast(dark["--guest-text"], dark["--guest-surface"])).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(colorContrast(dark["--guest-muted"], dark["--guest-surface"])).toBeGreaterThanOrEqual(
      4.5,
    );
  });
});
