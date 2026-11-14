/**
 * Canonical 80 mm POS receipt PDF renderer.
 *
 * Financial truth still comes exclusively from neo_document_payload().
 * This file owns presentation only:
 * - fixed 80 mm roll width
 * - variable document height
 * - receipt-safe wrapping
 * - canonical totals
 * - payment / transaction metadata
 * - KRA eTIMS QR and fiscal metadata where supplied
 *
 * A4 business documents remain in document-pdf.server.ts.
 */

import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import { embedDocumentFonts } from "./document-fonts.server";
import QRCode from "qrcode";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { documentTraceCode } from "./document-trace";

type ReceiptLine = {
  description?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  unit_price?: number | string | null;
  discount?: number | string | null;
  tax?: number | string | null;
  total?: number | string | null;
  note?: string | null;
};

type ReceiptTotal = {
  label: string;
  amount: number | string | null;
  emphasis?: boolean;
};

type ReceiptPayload = {
  type?: string;
  branch_id?: string | null;
  document: {
    number?: string | null;
    date?: string | null;
    status?: string | null;
    title?: string | null;
    subtitle?: string | null;
  };
  party?: {
    label?: string | null;
    name?: string | null;
    lines?: (string | null)[];
  };
  lines?: ReceiptLine[];
  totals?: ReceiptTotal[];
  meta?: Record<string, unknown>;
  property?: Record<string, unknown>;
  identity?: Record<string, unknown>;
  generated_at?: string | null;
};

const clean = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value).trim();

const humanLabel = (value: string): string =>
  value
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

const dateTime = (value: unknown): string => {
  const raw = clean(value);
  if (!raw) return "";

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;

  return parsed
    .toLocaleString("en-KE", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
    .replace(",", "");
};

const money = (value: unknown, currency: string): string => {
  if (value === null || value === undefined || value === "") return "";

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return clean(value);

  const formatted = new Intl.NumberFormat("en-KE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);

  return currency ? `${currency} ${formatted}` : formatted;
};

const qty = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "";

  const numeric = Number(value);

  if (!Number.isFinite(numeric)) return clean(value);

  return new Intl.NumberFormat("en-KE", {
    maximumFractionDigits: 3,
  }).format(numeric);
};

function splitLongWord(
  word: string,
  font: PDFFont,
  size: number,
  width: number,
): string[] {
  if (font.widthOfTextAtSize(word, size) <= width) return [word];

  const parts: string[] = [];
  let part = "";

  for (const character of word) {
    const candidate = `${part}${character}`;

    if (part && font.widthOfTextAtSize(candidate, size) > width) {
      parts.push(part);
      part = character;
    } else {
      part = candidate;
    }
  }

  if (part) parts.push(part);

  return parts;
}

function wrap(
  value: string,
  font: PDFFont,
  size: number,
  width: number,
): string[] {
  const normalised = value.replace(/\s+/g, " ").trim();
  if (!normalised) return [];

  const words = normalised
    .split(" ")
    .flatMap((word) => splitLongWord(word, font, size, width));

  const result: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;

    if (font.widthOfTextAtSize(candidate, size) <= width) {
      line = candidate;
      continue;
    }

    if (line) result.push(line);
    line = word;
  }

  if (line) result.push(line);

  return result;
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function scalarText(value: unknown): string {
  if (!isScalar(value)) return "";
  return clean(value);
}

const fiscalKey = (key: string) =>
  /kra|etims|fiscal|control|cu_|signature|invoice_number|invoice_no|receipt_signature/i.test(
    key,
  );

export async function buildThermalReceiptPdf(
  supabase: SupabaseClient<Database>,
  input: { type: "pos_receipt"; id: string },
): Promise<{
  filename: string;
  base64: string;
  documentNumber: string;
}> {
  const { data, error } = await supabase.rpc(
    "neo_document_payload" as never,
    {
      _type: input.type,
      _id: input.id,
    } as never,
  );

  if (error) throw new Error(error.message);

  const payload = data as unknown as ReceiptPayload | null;

  if (!payload) {
    throw new Error("This receipt is not available.");
  }

  const document = payload.document ?? {};
  const property = payload.property ?? {};
  const identity = payload.identity ?? {};
  const metaSource = payload.meta ?? {};
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const rawTotals = Array.isArray(payload.totals) ? payload.totals : [];

  const documentNumber = clean(document.number) || "Unnumbered";
  const documentTitle = clean(document.title) || "Receipt";

  const propertyName =
    clean(property["name"]) ||
    clean(identity["trading_name"]) ||
    clean(identity["organisation"]) ||
    "Property";

  const propertyAddress = [
    property["address"],
    property["city"],
    property["country"],
  ]
    .map(clean)
    .filter(Boolean)
    .join(", ");

  const propertyPhone = clean(property["phone"]);
  const propertyEmail = clean(property["email"]);

  const taxId = clean(identity["tax_id"]);
  const taxLabel = clean(identity["tax_id_label"]) || "PIN";

  const currency =
    clean(property["currency"]) ||
    clean(identity["currency"]) ||
    "KES";

  const partyName = clean(payload.party?.name);

  const qrPayload = clean(metaSource["qr_payload"]);

  const topMeta = Object.entries(metaSource)
    .filter(
      ([key, value]) =>
        key !== "qr_payload" &&
        !fiscalKey(key) &&
        isScalar(value) &&
        scalarText(value),
    )
    .map(([key, value]) => [humanLabel(key), scalarText(value)] as const);

  const fiscalMeta = Object.entries(metaSource)
    .filter(
      ([key, value]) =>
        key !== "qr_payload" &&
        fiscalKey(key) &&
        isScalar(value) &&
        scalarText(value),
    )
    .map(([key, value]) => [humanLabel(key), scalarText(value)] as const);

  const seenTotalLabels = new Set<string>();

  const totals = rawTotals.filter((total) => {
    if (!total) return false;
    if (total.amount === null || total.amount === undefined) return false;

    const label = clean(total.label);
    if (!label) return false;

    const key = label.toLowerCase();

    if (seenTotalLabels.has(key)) return false;

    seenTotalLabels.add(key);
    return true;
  });

  const pdf = await PDFDocument.create();
  const { regular, bold } = await embedDocumentFonts(pdf);

  // 80 mm roll = ~226.77 PDF points.
  const paperWidth = 226.77;
  const margin = 12;
  const contentWidth = paperWidth - margin * 2;
  const amountWidth = 72;
  const itemWidth = contentWidth - amountWidth - 8;

  const black = rgb(0.05, 0.05, 0.05);
  const muted = rgb(0.35, 0.35, 0.35);
  const rule = rgb(0.2, 0.2, 0.2);

  const pairLines = (label: string, value: string, labelFont: PDFFont, valueFont: PDFFont, labelSize: number, valueSize: number) => {
    const valueWidth = Math.min(contentWidth * 0.55, Math.max(60, valueFont.widthOfTextAtSize(value, valueSize)));
    return {
      labels: wrap(label, labelFont, labelSize, contentWidth - valueWidth - 8),
      values: wrap(value, valueFont, valueSize, valueWidth),
      lineHeight: Math.max(labelSize, valueSize) + 3,
    };
  };
  const pairHeight = (label: string, value: string, labelFont: PDFFont, valueFont: PDFFont, labelSize: number, valueSize: number) => {
    const pair = pairLines(label, value, labelFont, valueFont, labelSize, valueSize);
    return Math.max(1, pair.labels.length, pair.values.length) * pair.lineHeight;
  };
  const estimateMetaHeight = (entries: readonly (readonly [string, string])[]) =>
    entries.reduce((height, [label, value]) => height + pairHeight(label + ":", value, bold, regular, 7.3, 7.6), 0);

  const estimateLineHeight = (line: ReceiptLine) => {
    const description = clean(line.description) || "Item";
    const descriptionLines = wrap(description, bold, 8.5, itemWidth);

    const detailParts: string[] = [];
    const quantity = qty(line.quantity);
    const unitPrice = money(line.unit_price, currency);
    const unit = clean(line.unit);

    if (quantity && unitPrice) {
      detailParts.push(`${quantity}${unit ? ` ${unit}` : ""} × ${unitPrice}`);
    } else if (quantity) {
      detailParts.push(`Qty ${quantity}${unit ? ` ${unit}` : ""}`);
    } else if (unitPrice) {
      detailParts.push(`@ ${unitPrice}`);
    }

    const note = clean(line.note);
    if (note) detailParts.push(note);

    const detailHeight = detailParts.reduce((height, part) => height + wrap(part, regular, 7.1, contentWidth - 5).length * 9, 0);

    return Math.max(1, descriptionLines.length) * 10 + detailHeight + 7;
  };

  const propertyNameLines = wrap(propertyName, bold, 11.5, contentWidth);
  const addressLines = propertyAddress
    ? wrap(propertyAddress, regular, 7.5, contentWidth)
    : [];

  let estimatedHeight = 0;

  estimatedHeight += 18;
  estimatedHeight += propertyNameLines.length * 13;
  estimatedHeight += addressLines.length * 9;
  if (propertyPhone) estimatedHeight += 9;
  if (propertyEmail) estimatedHeight += 9;
  if (taxId) estimatedHeight += 9;

  estimatedHeight += 34;

  if (document.date) estimatedHeight += 11;
  if (partyName) estimatedHeight += pairHeight(clean(payload.party?.label) || "Guest:", partyName, bold, regular, 7.5, 7.5);

  estimatedHeight += estimateMetaHeight(topMeta);

  estimatedHeight += 28;

  for (const line of lines) {
    estimatedHeight += estimateLineHeight(line);
  }

  estimatedHeight += 18;

  estimatedHeight += totals.reduce((height, total) => {
    const label = clean(total.label), value = money(total.amount, currency);
    const emph = Boolean(total.emphasis) || /^(total|amount due|balance due|grand total)$/i.test(label);
    return height + pairHeight(emph ? label.toUpperCase() : label, value, emph ? bold : regular, bold, emph ? 10 : 8, emph ? 10 : 8) + (emph ? 24 : 0);
  }, 0);
  estimatedHeight += 22;

  if (fiscalMeta.length) {
    estimatedHeight += 20 + estimateMetaHeight(fiscalMeta);
  }

  if (qrPayload) {
    estimatedHeight += 112;
  }

  estimatedHeight += 78;

  // Continuous thermal roll: width is fixed; length grows with content.
  // The extra reserve protects against font/wrap rounding without compressing.
  const paperHeight = Math.max(320, Math.min(12000, estimatedHeight + 70));

  const page = pdf.addPage([paperWidth, paperHeight]);

  let y = paperHeight - 15;

  const drawLeft = (
    value: string,
    x: number,
    size: number,
    font: PDFFont = regular,
    color = black,
  ) => {
    page.drawText(value, {
      x,
      y,
      size,
      font,
      color,
    });
  };

  const drawRight = (
    value: string,
    right: number,
    size: number,
    font: PDFFont = regular,
    color = black,
  ) => {
    const width = font.widthOfTextAtSize(value, size);

    page.drawText(value, {
      x: right - width,
      y,
      size,
      font,
      color,
    });
  };

  const drawCentered = (
    value: string,
    size: number,
    font: PDFFont = regular,
    color = black,
  ) => {
    const width = font.widthOfTextAtSize(value, size);

    page.drawText(value, {
      x: Math.max(margin, (paperWidth - width) / 2),
      y,
      size,
      font,
      color,
    });
  };

  const lineRule = (dashed = false) => {
    if (dashed) {
      const dash = 4;
      const gap = 3;
      let x = margin;

      while (x < paperWidth - margin) {
        page.drawLine({
          start: { x, y },
          end: {
            x: Math.min(x + dash, paperWidth - margin),
            y,
          },
          thickness: 0.45,
          color: rule,
        });

        x += dash + gap;
      }
    } else {
      page.drawLine({
        start: { x: margin, y },
        end: { x: paperWidth - margin, y },
        thickness: 0.65,
        color: rule,
      });
    }

    y -= 10;
  };

  const drawWrappedCentered = (
    value: string,
    size: number,
    font: PDFFont,
    lineHeight: number,
    color = black,
  ) => {
    for (const part of wrap(value, font, size, contentWidth)) {
      drawCentered(part, size, font, color);
      y -= lineHeight;
    }
  };

  const drawPair = (label: string, value: string, labelFont: PDFFont, valueFont: PDFFont, labelSize: number, valueSize: number, labelColor = black) => {
    const pair = pairLines(label, value, labelFont, valueFont, labelSize, valueSize);
    const top = y;
    pair.labels.forEach((part, index) => {
      y = top - index * pair.lineHeight;
      drawLeft(part, margin, labelSize, labelFont, labelColor);
    });
    pair.values.forEach((part, index) => {
      y = top - index * pair.lineHeight;
      drawRight(part, paperWidth - margin, valueSize, valueFont);
    });
    y = top - Math.max(1, pair.labels.length, pair.values.length) * pair.lineHeight;
  };
  const drawMetaEntries = (entries: readonly (readonly [string, string])[]) => {
    for (const [label, value] of entries) drawPair(label + ":", value, bold, regular, 7.3, 7.6, muted);
  };

  // ----------------------------------------------------------------
  // PROPERTY IDENTITY
  // ----------------------------------------------------------------

  drawWrappedCentered(propertyName.toUpperCase(), 11.5, bold, 13);

  if (propertyAddress) {
    drawWrappedCentered(propertyAddress, 7.5, regular, 9, muted);
  }

  if (propertyPhone) {
    drawCentered(propertyPhone, 7.5, regular, muted);
    y -= 9;
  }

  if (propertyEmail) {
    drawCentered(propertyEmail, 7.5, regular, muted);
    y -= 9;
  }

  if (taxId) {
    drawCentered(`${taxLabel}: ${taxId}`, 7.5, regular, muted);
    y -= 9;
  }

  y -= 3;
  lineRule(true);

  drawCentered("RECEIPT", 10, bold);
  y -= 13;

  drawCentered(documentNumber, 8.5, bold);
  y -= 10;

  lineRule(true);

  // ----------------------------------------------------------------
  // TRANSACTION IDENTITY
  // ----------------------------------------------------------------

  const receiptDate = dateTime(document.date);

  if (receiptDate) {
    drawPair("Date:", receiptDate, bold, regular, 7.5, 7.5, muted);
  }

  if (partyName) {
    drawPair(clean(payload.party?.label) || "Guest:", partyName, bold, regular, 7.5, 7.5, muted);
  }

  if (topMeta.length) {
    drawMetaEntries(topMeta);
  }

  y -= 2;
  lineRule(true);

  // ----------------------------------------------------------------
  // ITEMS
  // ----------------------------------------------------------------

  drawLeft("ITEM", margin, 7.3, bold);
  drawRight("AMOUNT", paperWidth - margin, 7.3, bold);
  y -= 10;

  lineRule(false);

  for (const line of lines) {
    const description = clean(line.description) || "Item";
    const amount = money(line.total, currency);

    const descriptionLines = wrap(description, bold, 8.5, itemWidth);

    const rowTop = y;

    for (const [index, part] of descriptionLines.entries()) {
      page.drawText(part, {
        x: margin,
        y: rowTop - index * 10,
        size: 8.5,
        font: index === 0 ? bold : regular,
        color: black,
      });
    }

    if (amount) {
      const amountTextWidth = bold.widthOfTextAtSize(amount, 8.3);

      page.drawText(amount, {
        x: paperWidth - margin - amountTextWidth,
        y: rowTop,
        size: 8.3,
        font: bold,
        color: black,
      });
    }

    y = rowTop - Math.max(1, descriptionLines.length) * 10;

    const quantity = qty(line.quantity);
    const unitPrice = money(line.unit_price, currency);
    const unit = clean(line.unit);

    if (quantity && unitPrice) {
      drawLeft(
        `${quantity}${unit ? ` ${unit}` : ""} × ${unitPrice}`,
        margin + 5,
        7.1,
        regular,
        muted,
      );
      y -= 9;
    } else if (quantity) {
      drawLeft(
        `Qty ${quantity}${unit ? ` ${unit}` : ""}`,
        margin + 5,
        7.1,
        regular,
        muted,
      );
      y -= 9;
    } else if (unitPrice) {
      drawLeft(`@ ${unitPrice}`, margin + 5, 7.1, regular, muted);
      y -= 9;
    }

    const note = clean(line.note);

    if (note) {
      for (const part of wrap(note, regular, 7, itemWidth)) {
        drawLeft(part, margin + 5, 7, regular, muted);
        y -= 8;
      }
    }

    y -= 4;
  }

  lineRule(true);

  // ----------------------------------------------------------------
  // TOTALS
  // ----------------------------------------------------------------

  for (const total of totals) {
    const label = clean(total.label);
    const value = money(total.amount, currency);

    if (!label || !value) continue;

    const emphasised =
      Boolean(total.emphasis) ||
      /^(total|amount due|balance due|grand total)$/i.test(label);

    if (emphasised) {
      // Reserve a separate band above and below the entire wrapped total row.
      y -= 2;
      page.drawLine({start: {x: margin, y: y + 3}, end: {x: paperWidth - margin, y: y + 3}, thickness: 1.2, color: black});
      y -= 10;
      drawPair(label.toUpperCase(), value, bold, bold, 10, 10);
      page.drawLine({start: {x: margin, y: y + 1}, end: {x: paperWidth - margin, y: y + 1}, thickness: 1.2, color: black});
      y -= 10;
    } else {
      drawPair(label, value, regular, bold, 8, 8);
    }
  }

  // ----------------------------------------------------------------
  // FISCAL / KRA eTIMS
  // ----------------------------------------------------------------

  if (fiscalMeta.length || qrPayload) {
    y -= 3;
    lineRule(true);

    drawCentered("KRA eTIMS", 8, bold);
    y -= 12;

    if (fiscalMeta.length) {
      drawMetaEntries(fiscalMeta);
      y -= 2;
    }

    if (qrPayload) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qrPayload, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 220,
        });

        const encoded = qrDataUrl.split(",", 2)[1] ?? "";
        const qrImage = await pdf.embedPng(
          Buffer.from(encoded, "base64"),
        );

        const qrSize = 82;

        page.drawImage(qrImage, {
          x: (paperWidth - qrSize) / 2,
          y: y - qrSize,
          width: qrSize,
          height: qrSize,
        });

        y -= qrSize + 7;

        drawCentered("Scan to verify", 6.8, regular, muted);
        y -= 10;
      } catch {
        drawCentered(
          "KRA eTIMS QR could not be rendered.",
          6.8,
          regular,
          muted,
        );
        y -= 10;
      }
    }
  }

  // ----------------------------------------------------------------
  // PROVENANCE / FOOTER
  // ----------------------------------------------------------------

  y -= 4;
  lineRule(true);

  drawCentered("Thank you for your business.", 8.2, bold);
  y -= 12;

  const trace = documentTraceCode({
    organizationId: clean(identity["organisation_id"]) || null,
    propertyId: payload.branch_id ?? null,
    documentType: input.type,
    documentNumber,
  });

  if (trace) {
    for (const part of wrap(trace, regular, 5.7, contentWidth)) {
      drawCentered(part, 5.7, regular, muted);
      y -= 7;
    }
  }

  const generated = dateTime(payload.generated_at);

  if (generated) {
    drawCentered(`Generated ${generated}`, 5.7, regular, muted);
    y -= 8;
  }

  y -= 2;
  drawCentered("Powered by NEØ", 6.8, regular, muted);
  y -= 8;
  drawCentered(
    "Built by AI, Data & Marketing by Wambui",
    5.7,
    regular,
    muted,
  );

  pdf.setTitle(`Receipt ${documentNumber}`);
  pdf.setAuthor(clean(identity["organisation"]) || propertyName);
  pdf.setSubject(`POS receipt for ${propertyName}`);
  pdf.setCreationDate(new Date());

  const bytes = await pdf.save();

  const slug =
    `receipt-${documentNumber}`
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "receipt";

  return {
    filename: `${slug}.pdf`,
    base64: Buffer.from(bytes).toString("base64"),
    documentNumber,
  };
}
