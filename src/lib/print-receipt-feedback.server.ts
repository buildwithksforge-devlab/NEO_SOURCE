import QRCode from "qrcode";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function receiptFeedbackLink(value: unknown) {
  if (typeof value !== "string" || value.trim().length > 512) return "";
  try {
    const url = new URL(value.trim());
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Feedback is optional. */ }
  return "";
}

export function withReceiptFeedbackGraphic(job: Record<string, unknown> | null) {
  if (!job || job["document_type"] !== "pos_receipt") return job;
  const payload = record(job["payload"]);
  const source = record(payload["document"]);
  const brand = record(record(source["identity"])["brand"]);
  const url = receiptFeedbackLink(brand["receiptFeedbackUrl"]);
  if (!url) return job;
  try {
    const { modules } = QRCode.create(url, { errorCorrectionLevel: "M" });
    const margin = 4;
    const size = modules.size + margin * 2;
    const rows = Array.from({ length: size }, (_, y) =>
      Array.from({ length: size }, (_, x) =>
        y >= margin && y < size - margin && x >= margin && x < size - margin &&
        modules.get(y - margin, x - margin) ? "1" : "0"
      ).join("")
    );
    return { ...job, feedback_qr: rows };
  } catch {
    return job;
  }
}
