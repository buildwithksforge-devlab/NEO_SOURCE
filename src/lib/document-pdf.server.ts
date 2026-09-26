/**
 * Branded business-document renderer.
 *
 * Every printable output in NEØ (receipt, invoice, folio statement, BEO, LPO,
 * GRN, requisition, stock sheet, staff schedule, task sheet) is rendered here from the canonical `neo_document_payload`
 * service: the database issues the document number, computes the money and
 * enforces property scope. Nothing on this path is recomputed client-side.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DOCUMENT_BROWN, wireframeSegments } from "./document-artwork";
import { NEO_SYMBOL_BASE64 } from "./document-symbol";
import { documentTraceCode } from "./document-trace";


export const DOCUMENT_TYPES = [
  "pos_receipt",
  "invoice",
  "folio_statement",
  "beo",
  "purchase_order",
  "goods_receipt",
  "requisition",
  "stock_sheet",
  "staff_schedule",
  "task_sheet",
  "payslip",
] as const;

export type BusinessDocumentType = (typeof DOCUMENT_TYPES)[number];

type Line = {
  description?: string | null;
  quantity?: number | string | null;
  unit?: string | null;
  unit_price?: number | string | null;
  discount?: number | string | null;
  tax?: number | string | null;
  total?: number | string | null;
  date?: string | null;
  note?: string | null;
};

type Total = { label: string; amount: number | string | null; emphasis?: boolean };

type Payload = {
  type: string;
  document: { number?: string | null; date?: string | null; status?: string | null; title?: string | null; subtitle?: string | null };
  party: { label?: string | null; name?: string | null; lines?: (string | null)[] };
  lines: Line[];
  totals: Total[];
  meta: Record<string, unknown>;
  property: Record<string, unknown>;
  identity: Record<string, unknown>;
  generated_at: string;
};

const safeHex = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

const colour = (hex: string) =>
  rgb(
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  );

const text = (value: unknown) => (value === null || value === undefined ? "" : String(value));

const money = (value: unknown, currency: string) => {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${currency} ${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric)}`;
};

const quantity = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(numeric);
};

const dateLabel = (value: unknown) => {
  if (!value) return "";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toISOString().slice(0, 16).replace("T", " ");
};

const wrap = (value: string, font: PDFFont, size: number, width: number) => {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
};

export async function buildBusinessDocumentPdf(
  supabase: SupabaseClient<Database>,
  input: { type: BusinessDocumentType; id: string },
): Promise<{ filename: string; base64: string; documentNumber: string }> {
  const { data, error } = await supabase.rpc("neo_document_payload" as never, {
    _type: input.type,
    _id: input.id,
  } as never);
  if (error) throw new Error(error.message);
  const payload = data as unknown as Payload | null;
  if (!payload) throw new Error("This document is not available.");

  const identity = payload.identity ?? {};
  const property = payload.property ?? {};
  const brand = (identity["brand"] ?? {}) as Record<string, unknown>;
  const currency = text(property["currency"] || identity["currency"] || "");
  const primaryHex = safeHex(brand["primaryColor"], "#18C4C8");
  const darkHex = safeHex(brand["secondaryColor"], "#020A1C");
  const primary = colour(primaryHex);
  const dark = colour(darkHex);
  const muted = rgb(0.38, 0.4, 0.44);
  const rule = rgb(0.85, 0.87, 0.9);
  // The canonical house design: warm brown title block and total bar, a fine
  // blue-grey table rule, and the wireframe drawing in the upper-right corner.
  const brown = colour(DOCUMENT_BROWN);
  const tableRule = rgb(0.29, 0.44, 0.65);
  const inkBlack = rgb(0.07, 0.07, 0.07);

  /**
   * Property-facing outputs lead with the property's own mark when it has one
   * configured; only then do they fall back to the organisation logo. The
   * branch is read by id from the payload, so one property's mark can never
   * appear on another property's document.
   */
  const branchId = (payload as unknown as { branch_id?: string | null }).branch_id ?? null;
  let propertyLogo = text(property["logo_url"]);
  if (!propertyLogo && branchId) {
    const { data: branch } = await supabase
      .from("branches")
      .select("logo_url")
      .eq("id", branchId)
      .maybeSingle();
    propertyLogo = text((branch as { logo_url?: string | null } | null)?.logo_url);
  }
  const logoUrl =
    propertyLogo || text(brand["logoLight"]) || text(brand["logoDark"]) || "";


  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [pageWidth, pageHeight]: [number, number] = [595.28, 841.89];
  const margin = 44;
  const contentWidth = pageWidth - margin * 2;

  let embeddedLogo: Awaited<ReturnType<PDFDocument["embedPng"]>> | null = null;
  if (/^https?:\/\//.test(logoUrl)) {
    try {
      const response = await fetch(logoUrl);
      if (response.ok) {
        const bytes = await response.arrayBuffer();
        embeddedLogo = /png/i.test(response.headers.get("content-type") ?? logoUrl)
          ? await pdf.embedPng(bytes)
          : await pdf.embedJpg(bytes);
      }
    } catch {
      embeddedLogo = null;
    }
  }

  let page: PDFPage = pdf.addPage([pageWidth, pageHeight]);
  let pageNumber = 0;
  let y = 0;

  const documentNumber = text(payload.document?.number) || "Unnumbered";
  const documentTitle = text(payload.document?.title) || "Document";

  const startPage = () => {
    if (pageNumber > 0) page = pdf.addPage([pageWidth, pageHeight]);
    pageNumber += 1;
    // The wireframe is drawn from the same shared geometry as the on-screen
    // sheet, so screen and PDF are one drawing rather than two look-alikes.
    for (const segment of wireframeSegments({
      x: pageWidth - 176,
      y: pageHeight - 118,
      width: 176,
      height: 176,
    })) {
      if (segment.y1 > pageHeight || segment.y2 > pageHeight) continue;
      page.drawLine({
        start: { x: segment.x1, y: segment.y1 },
        end: { x: segment.x2, y: segment.y2 },
        thickness: 0.35,
        color: inkBlack,
      });
    }
    page.drawText(`${documentTitle} ${documentNumber}`, { x: margin, y: 26, size: 7.5, font: regular, color: muted });
    page.drawText(`Page ${pageNumber}`, { x: pageWidth - margin - 34, y: 26, size: 7.5, font: regular, color: muted });
    y = pageHeight - 62;
  };

  const ensure = (height: number) => {
    if (y - height < 48) startPage();
  };

  const draw = (value: string, x: number, size: number, font: PDFFont, colourValue = dark) => {
    page.drawText(value, { x, y, size, font, color: colourValue });
  };

  startPage();

  // ---- Masthead: property identity, always from the canonical record ----
  const organisation = text(identity["organisation"]) || "Organisation not configured";
  const propertyName = text(property["name"]) || "Property not configured";
  const addressParts = [property["address"], property["city"], property["country"]]
    .map(text)
    .filter(Boolean)
    .join(", ");
  const contactParts = [property["phone"], property["email"], identity["website"]]
    .map(text)
    .filter(Boolean)
    .join("  ·  ");
  const taxLine = identity["tax_id"]
    ? `${text(identity["tax_id_label"])}: ${text(identity["tax_id"])}`
    : `${text(identity["tax_id_label"]) || "Tax ID"}: Not configured`;

  // Client brand leads: mark and trading name top-left, metadata top-right.
  let mastheadX = margin;
  if (embeddedLogo) {
    const scaled = embeddedLogo.scale(34 / embeddedLogo.height);
    page.drawImage(embeddedLogo, { x: margin, y: y - 24, width: scaled.width, height: 34 });
    mastheadX = margin + scaled.width + 12;
  }

  const mastheadTop = y;
  page.drawText(organisation, { x: mastheadX, y, size: 14.5, font: bold, color: dark });
  y -= 15;
  page.drawText(propertyName, { x: mastheadX, y, size: 10, font: bold, color: primary });
  y -= 12;
  for (const line of [addressParts, contactParts, taxLine].filter(Boolean)) {
    page.drawText(line, { x: mastheadX, y, size: 8.5, font: regular, color: muted });
    y -= 11;
  }
  if (identity["registration_number"]) {
    page.drawText(`Registration: ${text(identity["registration_number"])}`, {
      x: mastheadX,
      y,
      size: 8.5,
      font: regular,
      color: muted,
    });
    y -= 11;
  }

  // ---- Document metadata block (top right) ----
  const metaEntries: [string, string][] = [
    ["Document no.", documentNumber],
    ["Date", dateLabel(payload.document?.date)],
  ];
  const metaSource = (payload.meta ?? {}) as Record<string, unknown>;
  for (const key of ["due_date", "reservation", "confirmation", "reference", "room", "stay"]) {
    const value = text(metaSource[key]);
    if (value) metaEntries.push([key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), value]);
  }
  const statusText = text(payload.document?.status);
  if (statusText) metaEntries.push(["Status", statusText.replace(/_/g, " ")]);

  const metaRight = pageWidth - margin;
  let metaY = mastheadTop;
  for (const [label, value] of metaEntries.filter(([, value]) => value)) {
    const labelWidth = regular.widthOfTextAtSize(label, 7.5);
    const valueWidth = bold.widthOfTextAtSize(value, 8.5);
    page.drawText(label, { x: metaRight - 118 - labelWidth / 1, y: metaY, size: 7.5, font: regular, color: muted });
    page.drawText(value, { x: metaRight - valueWidth, y: metaY, size: 8.5, font: bold, color: dark });
    metaY -= 12;
  }
  y = Math.min(y, metaY) - 6;

  page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 1, color: tableRule });
  y -= 26;

  // ---- Title band: brand tint, restrained, client-owned ----
  // Brown block, then the large uppercase title overlapping it — the signature
  // of the canonical NEØ document.
  page.drawRectangle({ x: margin, y: y + 6, width: 86, height: 20, color: brown });
  page.drawText(documentTitle.toUpperCase(), { x: margin + 40, y: y - 2, size: 24, font: bold, color: inkBlack });
  const subtitle = text(payload.document?.subtitle);
  if (subtitle) {
    const subtitleWidth = regular.widthOfTextAtSize(subtitle, 8.5);
    page.drawText(subtitle, {
      x: pageWidth - margin - 10 - subtitleWidth,
      y: y + 4,
      size: 8.5,
      font: regular,
      color: muted,
    });
  }
  y -= 34;

  // The balance is not restated here: it belongs once, on the brown total
  // band beneath the line items, so the reader never has to reconcile two
  // figures for the same thing.


  // ---- Party block ----
  const party = payload.party ?? {};
  if (party.name) {
    ensure(50);
    draw(String(party.label ?? "Party").toUpperCase(), margin, 7.5, bold, muted);
    y -= 12;
    draw(text(party.name), margin, 10.5, bold);
    y -= 12;
    for (const line of (party.lines ?? []).map(text).filter(Boolean)) {
      draw(line, margin, 8.5, regular, muted);
      y -= 10;
    }
    y -= 8;
  }


  // ---- Line items ----
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  const showMoney = lines.some((line) => line.unit_price !== undefined && line.unit_price !== null);
  const columns = showMoney
    ? [
        { key: "description", label: "Description", x: margin, width: 232, align: "left" as const },
        { key: "quantity", label: "Qty", x: margin + 244, width: 46, align: "right" as const },
        { key: "unit_price", label: "Unit", x: margin + 300, width: 78, align: "right" as const },
        { key: "tax", label: "Tax", x: margin + 386, width: 54, align: "right" as const },
        { key: "total", label: "Amount", x: margin + 448, width: 60, align: "right" as const },
      ]
    : [
        { key: "description", label: "Description", x: margin, width: 300, align: "left" as const },
        { key: "quantity", label: "Qty", x: margin + 320, width: 60, align: "right" as const },
        { key: "note", label: "Detail", x: margin + 390, width: 118, align: "right" as const },
      ];

  const descriptionColumn = columns[0]!;
  const drawHeader = () => {
    page.drawRectangle({ x: margin - 6, y: y - 5, width: contentWidth + 12, height: 18, color: rgb(0.95, 0.97, 0.98) });
    for (const column of columns) {
      const label = column.label.toUpperCase();
      const width = bold.widthOfTextAtSize(label, 7.5);
      page.drawText(label, {
        x: column.align === "right" ? column.x + column.width - width : column.x,
        y: y + 1,
        size: 7.5,
        font: bold,
        color: dark,
      });
    }
    y -= 22;
  };

  if (lines.length) {
    ensure(60);
    drawHeader();
    for (const line of lines) {
      const description = text(line.description) || "—";
      const wrapped = wrap(description, regular, 9, descriptionColumn.width);
      const noteText = text(line.note);
      const noteLines = showMoney && noteText ? wrap(noteText, regular, 7.5, descriptionColumn.width) : [];
      const rowHeight = wrapped.length * 11 + noteLines.length * 9 + 8;
      if (y - rowHeight < 48) {
        startPage();
        drawHeader();
      }
      const rowTop = y;
      for (const [index, part] of wrapped.entries()) {
        page.drawText(part, { x: descriptionColumn.x, y: rowTop - index * 11, size: 9, font: regular, color: dark });
      }
      for (const [index, part] of noteLines.entries()) {
        page.drawText(part, {
          x: descriptionColumn.x,
          y: rowTop - wrapped.length * 11 - index * 9,
          size: 7.5,
          font: regular,
          color: muted,
        });
      }
      for (const column of columns.slice(1)) {
        let value = "";
        if (column.key === "quantity") {
          value = [quantity(line.quantity), text(line.unit)].filter(Boolean).join(" ");
        } else if (column.key === "unit_price") {
          value = money(line.unit_price, currency);
        } else if (column.key === "tax") {
          value = line.tax === null || line.tax === undefined ? "—" : money(line.tax, currency);
        } else if (column.key === "total") {
          value = money(line.total, currency);
        } else if (column.key === "note") {
          value = text(line.note) || dateLabel(line.date);
        }
        if (!value) continue;
        const width = regular.widthOfTextAtSize(value, 9);
        page.drawText(value, {
          x: column.align === "right" ? column.x + column.width - width : column.x,
          y: rowTop,
          size: 9,
          font: column.key === "total" ? bold : regular,
          color: dark,
        });
      }
      y = rowTop - rowHeight;
      page.drawLine({
        start: { x: margin, y: y + 6 },
        end: { x: pageWidth - margin, y: y + 6 },
        thickness: 0.4,
        color: rule,
      });
    }
    y -= 10;
  }

  // ---- Totals: a right-aligned summary panel, total on a brand band ----
  // Each named figure appears once. A repeated label, or a second line that
  // merely restates the emphasised balance, is dropped so the band below is
  // the only place the amount owed is stated.
  const totalsRaw = (Array.isArray(payload.totals) ? payload.totals : []).filter(
    (total) => total && total.amount !== null && total.amount !== undefined && Number(total.amount) !== 0,
  );
  const emphasised = totalsRaw.find((total) => total.emphasis);
  const seenLabels = new Set<string>();
  const totals = totalsRaw.filter((total) => {
    const key = String(total.label ?? "").trim().toLowerCase();
    if (seenLabels.has(key)) return false;
    seenLabels.add(key);
    if (!total.emphasis && emphasised && Number(total.amount) === Number(emphasised.amount)) {
      return false;
    }
    return true;
  });

  if (totals.length) {
    const panelWidth = 240;
    const boxX = pageWidth - margin - panelWidth;
    ensure(totals.length * 16 + 30);
    for (const total of totals) {
      const value = money(total.amount, currency);
      const size = total.emphasis ? 11 : 9;
      const font = total.emphasis ? bold : regular;
      if (total.emphasis) {
        page.drawRectangle({ x: boxX, y: y - 6, width: panelWidth, height: 22, color: brown });
      }
      page.drawText(total.label, {
        x: boxX + (total.emphasis ? 10 : 4),
        y: total.emphasis ? y + 1 : y,
        size,
        font,
        color: total.emphasis ? rgb(1, 1, 1) : muted,
      });
      const width = font.widthOfTextAtSize(value, size);
      page.drawText(value, {
        x: pageWidth - margin - width - (total.emphasis ? 10 : 4),
        y: total.emphasis ? y + 1 : y,
        size,
        font,
        color: total.emphasis ? rgb(1, 1, 1) : dark,
      });
      y -= total.emphasis ? 28 : 14;
      if (!total.emphasis) {
        page.drawLine({
          start: { x: boxX + 4, y: y + 8 },
          end: { x: pageWidth - margin - 4, y: y + 8 },
          thickness: 0.35,
          color: rule,
        });
      }
    }
    y -= 6;
  }

  // ---- Payment information, terms and operational detail ----
  const shownInHeader = new Set(["due_date", "reservation", "confirmation", "reference", "room", "stay"]);
  const meta = Object.entries(payload.meta ?? {}).filter(
    ([label, value]) => !shownInHeader.has(label) && value !== null && value !== "" && value !== undefined,
  );
  if (meta.length) {
    ensure(40);
    draw("PAYMENT INFORMATION, TERMS & DETAIL", margin, 7.5, bold, muted);
    y -= 13;
    for (const [label, value] of meta) {
      const body = typeof value === "object" ? JSON.stringify(value) : String(value);
      const wrapped = wrap(`${label.replace(/_/g, " ")}: ${body}`, regular, 8.5, contentWidth);
      ensure(wrapped.length * 11 + 6);
      for (const part of wrapped) {
        draw(part, margin, 8.5, regular, dark);
        y -= 11;
      }
      y -= 2;
    }
    y -= 6;
  }

  // ---- Footer: property contact, then quiet provenance ----
  ensure(64);
  page.drawLine({ start: { x: margin, y: y + 10 }, end: { x: pageWidth - margin, y: y + 10 }, thickness: 1, color: brown });
  page.drawText(`${propertyName} · ${organisation}`, { x: margin + 10, y: y - 2, size: 8, font: bold, color: dark });
  const footerContact = [addressParts, contactParts].filter(Boolean).join("  ·  ");
  if (footerContact) {
    page.drawText(footerContact.slice(0, 150), { x: margin + 10, y: y - 14, size: 7, font: regular, color: muted });
  }
  page.drawText(
    `Generated ${dateLabel(payload.generated_at)} from the canonical record. Document number issued by the system; amounts are not recalculated at print time.`,
    { x: margin + 10, y: y - 25, size: 6.5, font: regular, color: muted },
  );

  // Immutable trace code, then the centred house signature.
  const trace = documentTraceCode({
    organizationId: text(identity["organisation_id"]) || null,
    propertyId: branchId,
    documentType: input.type,
    documentNumber,
  });
  if (trace) {
    page.drawText(trace, { x: margin + 10, y: y - 36, size: 6.5, font: regular, color: muted });
  }

  // The permanent NEØ mark, set quietly in the lower-right corner. It sits in
  // the existing footer margin, so nothing above it moves.
  try {
    const symbol = await pdf.embedPng(Buffer.from(NEO_SYMBOL_BASE64, "base64"));
    const symbolSize = 26;
    page.drawImage(symbol, {
      x: pageWidth - margin - symbolSize,
      y: y - 44,
      width: symbolSize,
      height: symbolSize,
    });
  } catch {
    // A mark that cannot be embedded must never cost the document itself.
  }

  const signature = "Powered by NEØ";
  const signatureWidth = regular.widthOfTextAtSize(signature, 7);
  page.drawText(signature, {
    x: (pageWidth - signatureWidth) / 2,
    y: y - 50,
    size: 7,
    font: regular,
    color: muted,
  });

  const credit = "Built by AI, Data & Marketing by Wambui";
  const creditWidth = regular.widthOfTextAtSize(credit, 6);
  page.drawText(credit, {
    x: (pageWidth - creditWidth) / 2,
    y: y - 60,
    size: 6,
    font: regular,
    color: muted,
  });


  pdf.setTitle(`${documentTitle} ${documentNumber}`);
  pdf.setAuthor(organisation);
  pdf.setSubject(`${documentTitle} for ${propertyName}`);
  pdf.setCreationDate(new Date());

  const bytes = await pdf.save();
  const slug = `${documentTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${documentNumber}`
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return { filename: `${slug}.pdf`, base64: Buffer.from(bytes).toString("base64"), documentNumber };
}
