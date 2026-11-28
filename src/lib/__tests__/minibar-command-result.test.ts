import { describe, expect, it } from "vitest";
import { requireMinibarPostingResult } from "../minibar-command-result";
const saved = {
  ok: true,
  posting_id: "00000000-0000-4000-8000-000000000001",
  posting_number: "MB-1",
  lines: 2,
  total: 200,
};
describe("minibar saved posting response", () => {
  it("requires the saved posting identity, line count and finite total", () => {
    expect(requireMinibarPostingResult(saved, 2)).toEqual(saved);
    expect(requireMinibarPostingResult({ ...saved, total: "200.00" }, 2)["posting_number"]).toBe(
      "MB-1",
    );
  });
  it.each([
    null,
    {},
    { ok: true },
    { ...saved, posting_id: "not-an-id" },
    { ...saved, posting_number: "" },
    { ...saved, lines: 1 },
    { ...saved, total: "NaN" },
    { ...saved, total: Infinity },
    { ...saved, total: -1 },
    { ...saved, ok: false },
  ])("does not report malformed or failed result as posted: %j", (value) => {
    expect(() => requireMinibarPostingResult(value, 2)).toThrow();
  });
});
