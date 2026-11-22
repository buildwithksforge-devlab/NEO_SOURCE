import { expect, it } from "vitest";
import QRCode from "qrcode";
import { receiptQrConfig } from "@/lib/receipt-qr";
import { withReceiptFeedbackGraphic } from "@/lib/print-receipt-feedback.server";

it("keeps old feedback links and handles public links independently of payment", () => {
  const link = "https://hotel.example/menu";
  expect(receiptQrConfig({ receiptFeedbackUrl: link })).toEqual({ url: link, caption: "Scan to leave feedback" });
  expect(receiptQrConfig({ receiptFeedbackUrl: link, receiptQrDestination: "off" })).toBeNull();
  expect(receiptQrConfig({ receiptFeedbackUrl: "https://user:pass@hotel.example" })).toBeNull();
  expect(receiptQrConfig({ receiptFeedbackUrl: "javascript:alert(1)" })).toBeNull();
});

it("encodes the exact configured destination for the print agent", () => {
  const link = "https://hotel.example/menu?section=dinner";
  const job = { document_type: "pos_receipt", payload: { document: { identity: { brand: {
    receiptFeedbackUrl: link, receiptQrDestination: "menu",
  } } } } };
  const graphic = withReceiptFeedbackGraphic(job);
  expect(graphic?.["feedback_qr_caption"]).toBe("Scan to view the menu");
  const { modules } = QRCode.create(link, { errorCorrectionLevel: "M" });
  const rows = graphic?.["feedback_qr"] as string[];
  expect(rows).toHaveLength(modules.size + 8);
  const printed = rows.slice(4, -4).flatMap((row) => row.slice(4, -4).split("").map(Number));
  expect(printed).toEqual(Array.from(modules.data));
});
