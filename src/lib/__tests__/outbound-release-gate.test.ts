import { afterEach, describe, expect, it } from "vitest";
import { processCommunicationQueue } from "../automation-engine.server";

const previousEnabled = process.env["NEO_OUTBOUND_ENABLED"];
const previousCutoff = process.env["NEO_OUTBOUND_CUTOFF"];
afterEach(() => {
  if (previousEnabled === undefined) delete process.env["NEO_OUTBOUND_ENABLED"];
  else process.env["NEO_OUTBOUND_ENABLED"] = previousEnabled;
  if (previousCutoff === undefined) delete process.env["NEO_OUTBOUND_CUTOFF"];
  else process.env["NEO_OUTBOUND_CUTOFF"] = previousCutoff;
});

describe("historical outbound queue release", () => {
  it("cannot contact a provider or database when release is not configured", async () => {
    process.env["NEO_OUTBOUND_ENABLED"] = "true";
    delete process.env["NEO_OUTBOUND_CUTOFF"];
    const inaccessibleAdmin = new Proxy({}, { get: () => { throw new Error("No data access allowed"); } });
    expect(await processCommunicationQueue(inaccessibleAdmin as never, "historical-org"))
      .toMatchObject({ disabled: true, sent: 0 });
  });
});
