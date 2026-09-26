import { describe, expect, it } from "vitest";
import { explainPosSendError } from "@/lib/pos-data";

describe("POS send rejection messages", () => {
  it("explains an unresolved production station as configuration, not failure", () => {
    const message = explainPosSendError(
      "routing_unresolved: 2 item(s) have no production station configured for this property",
    );
    expect(message).toContain("Not sent");
    expect(message).toContain("2 item(s)");
    expect(message).toContain("Assign a station");
  });

  it("passes other rejections through to the status explanation", () => {
    expect(explainPosSendError("something else")).toBe("something else");
  });
});
