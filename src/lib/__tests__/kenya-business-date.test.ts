import {
  describe,
  expect,
  it,
} from "vitest";

import {
  kenyaBusinessDate,
} from "../kenya-business-date";

describe("NEO Kenya business reporting dates", () => {
  it("uses Kenya date when UTC is still yesterday", () => {
    const instant = new Date(
      "2026-11-24T22:30:00Z",
    );

    expect(kenyaBusinessDate(instant)).toBe(
      "2026-11-25",
    );
  });

  it("uses Kenya date early in the morning", () => {
    const instant = new Date(
      "2026-11-25T02:35:00Z",
    );

    expect(kenyaBusinessDate(instant)).toBe(
      "2026-11-25",
    );
  });

  it("handles a month boundary", () => {
    const instant = new Date(
      "2026-11-30T22:30:00Z",
    );

    expect(kenyaBusinessDate(instant)).toBe(
      "2026-12-01",
    );
  });

  it("handles a year boundary", () => {
    const instant = new Date(
      "2026-12-31T22:30:00Z",
    );

    expect(kenyaBusinessDate(instant)).toBe(
      "2027-01-01",
    );
  });

  it("is independent of the user's local timezone", () => {
    expect(
      kenyaBusinessDate(
        new Date("2026-11-25T12:00:00Z"),
      ),
    ).toBe("2026-11-25");
  });

  it("rejects an invalid instant", () => {
    expect(() =>
      kenyaBusinessDate(new Date("invalid")),
    ).toThrow("Invalid reporting instant");
  });
});
