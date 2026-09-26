import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * RUN 1 closure guards.
 *
 * These lock in the three defects found on the live records: a folio screen
 * that re-added its own total, a trace that stopped at the charges, and money
 * screens quietly falling back to legacy arithmetic.
 */

const folioScreen = readFileSync("src/routes/_shell.pms.folios.$id.tsx", "utf8");
const trace = readFileSync("src/lib/folio-identity.ts", "utf8");
const statement = readFileSync("src/components/pms/FolioStatementDialog.tsx", "utf8");
const guestFolio = readFileSync("src/routes/guest.$hotelSlug.folio.tsx", "utf8");

describe("the folio screen reads the canonical projection", () => {
  it("asks the one projection for the bill", () => {
    expect(folioScreen).toContain("useFolioProjection");
    expect(folioScreen).toContain("proj?.grossObligation");
    expect(folioScreen).toContain("proj?.collected");
    expect(folioScreen).toContain("proj?.outstanding");
    expect(folioScreen).toContain("proj?.serviceCharge");
  });

  it("never re-adds charges, service and tax into the displayed total", () => {
    expect(folioScreen).not.toMatch(/value=\{money\(f\["total_charges"\]/);
    expect(folioScreen).not.toMatch(/value=\{money\(f\["total_payments"\]/);
    expect(folioScreen).not.toMatch(/value=\{money\(f\["balance"\]/);
    expect(folioScreen).not.toContain("Math.round((netCharges");
    expect(statement).toContain("useFolioProjection");
    expect(statement).not.toMatch(/money\(f\["total_(charges|payments)"\]/);
    expect(statement).not.toMatch(/money\(f\["balance"\]/);
    expect(guestFolio).toContain("activeFolio?.gross_obligation");
    expect(guestFolio).toContain("activeFolio?.net_revenue");
    expect(guestFolio).not.toContain("activeFolio?.total_charges");
    expect(guestFolio).not.toContain("activeFolio?.balance");
  });
});

describe("the folio trace includes settlement", () => {
  it("carries receipts, their journal and their captured actor", () => {
    expect(trace).toContain('kind: "payment"');
    expect(trace).toContain("neo_folio_payment_trace");
  });

  it("claims the ledger only when a posted journal proves it", () => {
    expect(trace).toContain('trail?.["journal_status"] === "posted"');
  });

  it("says so plainly when no actor was captured, rather than inventing one", () => {
    expect(trace).toContain("Actor not captured");
  });
});
