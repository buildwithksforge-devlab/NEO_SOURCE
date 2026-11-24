export const RECEIPT_QR_DESTINATIONS = {
  feedback: "Scan to leave feedback",
  menu: "Scan to view the menu",
  socials: "Scan to find us online",
  link: "Scan to open the link",
  off: "",
} as const;

export type ReceiptQrDestination = keyof typeof RECEIPT_QR_DESTINATIONS;

export function receiptQrDestination(value: unknown): ReceiptQrDestination {
  return typeof value === "string" && Object.hasOwn(RECEIPT_QR_DESTINATIONS, value)
    ? value as ReceiptQrDestination : "feedback";
}

export function receiptQrLink(value: unknown): string {
  if (typeof value !== "string" || value.trim().length > 512) return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password && url.href.length <= 512
      ? url.href : "";
  } catch {
    return "";
  }
}

export function receiptQrConfig(brand: Record<string, unknown>) {
  const destination = receiptQrDestination(brand["receiptQrDestination"]);
  const url = receiptQrLink(brand["receiptFeedbackUrl"]);
  const caption = RECEIPT_QR_DESTINATIONS[destination];
  return url && caption ? { url, caption } : null;
}
