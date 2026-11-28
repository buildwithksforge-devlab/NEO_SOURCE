import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(path, "utf8");

describe("supplier availability interface integration", () => {
  const form = read(
    "src/components/partner/SupplierAvailabilityForm.tsx"
  );

  const partner = read(
    "src/components/partner/SupplierRfqs.tsx"
  );

  const procurement = read(
    "src/routes/_shell.procurement.quotations.tsx"
  );

  const history = read(
    "src/components/procurement/SupplierAvailabilityHistory.tsx"
  );

  const api = read(
    "src/lib/supplier-availability-api.ts"
  );

  it("mounts availability in the supplier RFQ application", () => {
    expect(partner).toContain(
      "<SupplierAvailabilityForm"
    );
  });

  it("preserves the existing quotation form", () => {
    expect(partner).toContain("<SupplierRfqForm");
  });

  it("passes property and relationship identity", () => {
    expect(partner).toContain("branchId={branchId}");

    expect(partner).toContain(
      "relationshipId={relationshipId}"
    );
  });

  it("connects form submission to the transaction hook", () => {
    expect(form).toContain(
      "await submit.mutateAsync"
    );
  });

  it("validates requested quantities", () => {
    expect(form).toContain(
      "prepareSupplierAvailabilityLine"
    );
  });

  it("prevents concurrent form submissions", () => {
    expect(form).toContain("sending.current");
  });

  it("requires confirmed response identity", () => {
    expect(api).toContain(
      "assertAvailabilityResponse(data)"
    );
  });

  it("provides unavailable product responses", () => {
    expect(form).toContain(
      'fillAvailability("none")'
    );
  });

  it("provides alternative product input", () => {
    expect(form).toContain("Alternative product");
  });

  it("retains transaction identity during a retry", () => {
    expect(form).toContain(
      "attemptId: attempt.current.id"
    );
  });

  it("mounts response history in procurement", () => {
    expect(procurement).toContain(
      "<SupplierAvailabilityHistory"
    );
  });

  it("distinguishes current and previous responses", () => {
    expect(history).toContain(
      "Latest availability response"
    );

    expect(history).toContain("Previous response");
  });

  it("does not claim availability is purchase approval", () => {
    expect(history).toContain(
      "does not independently authorise"
    );
  });

  it("displays unsuccessful queries separately from empty results", () => {
    expect(history).toContain("query.isError");

    expect(history).toContain(
      "query.isSuccess && rows.length === 0"
    );
  });

  it("refreshes supplier RFQs after submission", () => {
    expect(api).toContain(
      '"partner-supplier-rfqs"'
    );
  });
});