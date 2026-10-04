import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("eTIMS fiscal document wiring", () => {
  it("extends canonical invoice payload from stored eTIMS submission data", () => {
    const migration = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20261004090000_invoice_fiscal_document_payload.sql",
      ),
      "utf8",
    );

    expect(migration).toContain("from etims_submissions s");
    expect(migration).toContain("s.invoice_id = v.id");
    expect(migration).toContain("'KRA reference', es.kra_reference");
    expect(migration).toContain("'Control unit reference', es.control_unit_reference");
    expect(migration).toContain("'qr_payload', es.qr_payload");
    expect(migration).toContain("'Fiscal error', es.error_details");

    expect(migration).toContain("jsonb_build_object('label','Total','amount',v.total,'emphasis',true)");
    expect(migration).toContain("jsonb_build_object('label','Tax','amount',v.tax_total)");
  });

  it("renders stored qr_payload as a QR image instead of plain metadata text", () => {
    const renderer = fs.readFileSync(
      path.join(process.cwd(), "src/lib/document-pdf.server.ts"),
      "utf8",
    );

    expect(renderer).toContain('import QRCode from "qrcode"');
    expect(renderer).toContain('const qrPayload = text(metaSource["qr_payload"])');
    expect(renderer).toContain('label !== "qr_payload"');
    expect(renderer).toContain("QRCode.toDataURL(qrPayload");
    expect(renderer).toContain("pdf.embedPng(qrBytes)");
    expect(renderer).toContain("KRA eTIMS VERIFICATION");
  });

  it("exposes accepted, pending and retry states in Accounts Receivable", () => {
    const route = fs.readFileSync(
      path.join(process.cwd(), "src/routes/_shell.finance.receivables.tsx"),
      "utf8",
    );

    expect(route).toContain("useEtimsSubmissions");
    expect(route).toContain("KRA Ref:");
    expect(route).toContain("Control Unit:");
    expect(route).toContain("Fiscalisation pending.");
    expect(route).toContain("Fiscalisation failed.");
    expect(route).toContain('label={fiscalFailed ? "Retry fiscalisation" : "File with KRA"}');
    expect(route).toContain('"Fiscal PDF"');
  });
});