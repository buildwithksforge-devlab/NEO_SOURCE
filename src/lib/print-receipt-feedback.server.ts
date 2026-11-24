import QRCode from "qrcode";
import { receiptQrConfig } from "./receipt-qr";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function withReceiptFeedbackGraphic(job: Record<string, unknown> | null) {
  if (!job || job["document_type"] !== "pos_receipt") return job;
  const payload = record(job["payload"]);
  const source = record(payload["document"]);
  const brand = record(record(source["identity"])["brand"]);
  const qr = receiptQrConfig(brand);
  if (!qr) return job;
  try {
    const { modules } = QRCode.create(qr.url, { errorCorrectionLevel: "M" });
    const margin = 4;
    const size = modules.size + margin * 2;
    const rows = Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) =>
        y >= margin && y < size - margin && x >= margin && x < size - margin &&
        modules.get(y - margin, x - margin) ? "1" : "0"
      ).join("")
    );
    return { ...job, feedback_qr: rows, feedback_qr_caption: qr.caption };
  } catch {
    return job;
  }
}
