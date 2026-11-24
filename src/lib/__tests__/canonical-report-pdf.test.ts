import { PDFPage } from "pdf-lib";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { buildManagementReportPdf } from "@/lib/report-pdf.server";

afterEach(() => vi.restoreAllMocks());

it.each([true, false])("keeps payroll money permission and stock units in the canonical report (money allowed: %s)", async (moneyAllowed) => {
  const draw = vi.spyOn(PDFPage.prototype, "drawText");
  const rpc = vi.fn(async (name: string) => ({ data: name === "has_permission" ? true : name === "neo_facts" ? {
    monetary_authorised: moneyAllowed, scope: { currency: "KES" },
    accounting: { payroll_cost: 45789, gross_margin: 32.4 },
    inventory: { stock_turnover: 2.25, days_on_hand: 18 },
  } : {}, error: null }));
  const from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { organization_id: "fixture", name: "Sample Hotel" } }) }) }) });
  const result = await buildManagementReportPdf({ rpc, from } as unknown as Parameters<typeof buildManagementReportPdf>[0], "sample", {
    title: "Profit, payroll & stock turnover", branchId: null, from: "2026-11-01", to: "2026-11-22",
    paths: ["accounting.payroll_cost", "accounting.gross_margin", "inventory.stock_turnover", "inventory.days_on_hand"],
  });
  const rendered = draw.mock.calls.map(([text]) => text).join(" ");
  expect(rendered).toContain("2.25×");
  expect(rendered).toContain("18 days");
  expect(rendered.includes("KES 45,789.00")).toBe(moneyAllowed);
  const evidenceDir = process.env["RECEIPT_EVIDENCE_DIR"];
  if (moneyAllowed && evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    writeFileSync(`${evidenceDir}/profit-payroll-stock-turnover.pdf`, Buffer.from(result.base64, "base64"));
  }
});
