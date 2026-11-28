/**
 * Branded business-document renderer.
 *
 * Every printable output in NEØ (receipt, invoice, folio statement, BEO, LPO,
 * GRN, requisition, stock sheet, staff schedule, task sheet) is rendered here from the canonical `neo_document_payload`
 * service: the database issues the document number, computes the money and
 * enforces property scope. Nothing on this path is recomputed client-side.
 */
import { PDFDocument, PrintScaling, rgb, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, type PDFFont, type PDFPage } from "pdf-lib";
import { embedDocumentFonts } from "./document-fonts.server";
import QRCode from "qrcode";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DOCUMENT_BROWN, wireframeSegments } from "./document-artwork";
import { NEO_SYMBOL_BASE64 } from "./document-symbol";
import { documentTraceCode } from "./document-trace";
import { documentLayout } from "./document-layouts";
import { readFolioChargeComponents } from "./folio-charge-components";
import { embedDocumentLogo } from "./document-logo.server";
import { documentTaxTotals } from "./document-tax-totals";


export const DOCUMENT_TYPES = [
  "pos_receipt",
  "invoice",
  "credit_note",
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
  category?: string | null;
  date?: string | null;
  note?: string | null;
};

type Total = { label: string; amount: number | string | null; emphasis?: boolean; section?: "tax" };

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
  return `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(numeric)}`;
};

const quantity = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 }).format(numeric);
};

const formatDocumentDate = (value: unknown, timeZone: string) => {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone }).format(parsed);
};

const wrap = (value: string, font: PDFFont, size: number, width: number) => {
  const words = value.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (font.widthOfTextAtSize(word, size) > width) {
      if (line) { lines.push(line); line = ""; }
      let fragment = "";
      for (const character of word) {
        if (fragment && font.widthOfTextAtSize(fragment + character, size) > width) {
          lines.push(fragment); fragment = "";
        }
        fragment += character;
      }
      line = fragment;
      continue;
    }
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

export async function readSavedFolioTaxRows(
  client: SupabaseClient<Database>, folioId: string, branchId: string | null, savedTax: number,
): Promise<Total[]> {
  const fallback = [{ label: "Recorded tax", amount: savedTax }];
  const { data, error } = await client.rpc("neo_folio_document_tax_rows" as never, {
    _folio: folioId, _property: branchId,
  } as never);
  if (error?.code === "PGRST202") return fallback;
  if (error) throw new Error(error.message);
  const payload = data as unknown;
  if (!Array.isArray(payload) || !payload.length) return fallback;

  const rows: Total[] = [];
  for (const value of payload as unknown[]) {
    if (!value || typeof value !== "object") return fallback;
    const { label, amount } = value as { label?: unknown; amount?: unknown };
    if (typeof label !== "string" || !label.trim() || typeof amount !== "number" || !Number.isFinite(amount)) return fallback;
    rows.push({ label, amount, section: "tax" });
  }
  const taxCents = rows.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
  return taxCents === Math.round(savedTax * 100) ? rows : fallback;
}

export async function buildBusinessDocumentPdf(
  supabase: SupabaseClient<Database>,
  input: { type: BusinessDocumentType; id: string },
): Promise<{ filename: string; base64: string; documentNumber: string }> {
  /**
   * POS receipts are physically different documents.
   *
   * They retain the same canonical backend payload, numbering and financial
   * truth, but render to a continuous 80 mm roll instead of forcing the A4
   * business-document furniture onto a thermal printer.
   */
  if (input.type === "pos_receipt") {
    const { buildThermalReceiptPdf } = await import(
      "./document-thermal-pdf.server"
    );

    return buildThermalReceiptPdf(supabase, {
      type: "pos_receipt",
      id: input.id,
    });
  }

  const { data, error } = await supabase.rpc("neo_document_payload" as never, {
    _type: input.type,
    _id: input.id,
  } as never);
  if (error) throw new Error(error.message);
  const payload = data as unknown as Payload | null;
  if (!payload) throw new Error("This document is not available.");

  // Print the same canonical financial projection as the folio preview.
  // Stored folio summary columns can lag their underlying ledger; never
  // silently substitute those columns when the authoritative read fails.
  if (input.type === "folio_statement") {
    const { data: result, error: projectionError } = await supabase.rpc(
      "neo_folio_projection" as never, { _folio: input.id } as never,
    );
    if (projectionError) throw new Error(projectionError.message);
    const projection = result as unknown as Record<string, unknown> | null;
    if (projection?.["found"] !== true || projection["folio_id"] !== input.id) {
      throw new Error("The folio financial position could not be verified.");
    }
    const amount = (key: string) => {
      const raw = projection[key];
      if (raw === null || raw === undefined || raw === "" || !Number.isFinite(Number(raw))) {
        throw new Error(`The folio financial position has an invalid ${key}.`);
      }
      return Number(raw);
    };
    const outstanding = amount("outstanding");
    const charges = readFolioChargeComponents(projection);
    if (Math.abs(amount("net_revenue") + amount("tax") + amount("service_charge") + charges.otherCharges - amount("gross_obligation")) >= 0.005
      || Math.abs(amount("collected") + outstanding - amount("gross_obligation")) >= 0.005) {
      throw new Error("The folio financial components do not reconcile. Review the ledger before printing.");
    }
    payload.totals = [
      { label: "Net charges", amount: amount("net_revenue") },
      ...await readSavedFolioTaxRows(supabase, input.id, typeof projection["branch_id"] === "string" ? projection["branch_id"] : null, amount("tax")),
      { label: "Service charge", amount: amount("service_charge") },
      ...charges.chargeComponents.map((charge) => ({ label: charge.label, amount: charge.amount })),
      { label: "Gross billed", amount: amount("gross_obligation") },
      { label: "Collected", amount: amount("collected") },
      { label: outstanding < 0 ? "Refund due" : "Outstanding", amount: Math.abs(outstanding), emphasis: true },
    ];
    const { data: ledgerLines, error: linesError } = await supabase
      .from("folio_lines")
      .select("description,category,quantity,unit_price,discount_amount,tax_amount,net_amount,posting_date,status,line_type")
      .eq("folio_id", input.id)
      .order("posting_date");
    if (linesError) throw new Error(linesError.message);
    payload.lines = (ledgerLines ?? []).filter((line) =>
      !["void", "voided", "reversed"].includes(line.status ?? "posted") &&
      !["payment", "deposit", "refund"].includes(line.line_type ?? "charge")
    ).map((line) => ({
      description: line.description || line.category || "Charge", category: line.category,
      quantity: line.quantity, unit_price: line.unit_price,
      discount: line.discount_amount, tax: line.tax_amount,
      total: line.net_amount, date: line.posting_date,
    }));
  }

  const property = payload.property ?? {};
  const branchId = (payload as unknown as { branch_id?: string | null }).branch_id ?? null;
  if (branchId && (!property["logo_url"] || !property["timezone"])) {
    const { data: branch } = await supabase
      .from("branches")
      .select("logo_url, timezone")
      .eq("id", branchId)
      .maybeSingle();
    payload.property = {
      ...property,
      logo_url: property["logo_url"] || branch?.logo_url,
      timezone: branch?.timezone || property["timezone"],
    };
  }
  return renderBusinessDocumentPdf(payload, input.type, branchId);
}

export async function renderBusinessDocumentPdf(payload: Payload, type: BusinessDocumentType, branchId: string | null) {
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

  const propertyLogo = text(property["logo_url"]);
  const documentTimezone = text(property["timezone"]) || text(identity["timezone"]) || "UTC";
  const dateLabel = (value: unknown) => formatDocumentDate(value, documentTimezone);
  const pdf = await PDFDocument.create();
  pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const { regular, bold } = await embedDocumentFonts(pdf);
  const [pageWidth, pageHeight]: [number, number] = [595.28, 841.89];
  const margin = 39.7;
  const footerTop = 138;
  const bodyBottom = footerTop + 18;
  const contentWidth = pageWidth - margin * 2;

  const embeddedLogo = await embedDocumentLogo(pdf, [propertyLogo, text(brand["logoLight"]), text(brand["logoDark"])]);

  let page: PDFPage = pdf.addPage([pageWidth, pageHeight]);
  let pageNumber = 0;
  let y = 0;

  const documentNumber = text(payload.document?.number) || "Unnumbered";
  const documentTitle = text(payload.document?.title) || "Document";
  const layout = documentLayout(type);

  const startPage = () => {
    if (pageNumber > 0) page = pdf.addPage([pageWidth, pageHeight]);
    pageNumber += 1;
    // Match the preview's 62mm × 42mm SVG viewport, including its crop.
    const cornerWidth = 175.75, cornerHeight = 119.06, scale = cornerWidth / 190;
    page.pushOperators(pushGraphicsState(), rectangle(pageWidth - cornerWidth, pageHeight - cornerHeight, cornerWidth, cornerHeight), clip(), endPath());
    for (const segment of wireframeSegments({ x: 0, y: -34, width: 190, height: 190 })) {
      page.drawLine({
        start: { x: pageWidth - cornerWidth + segment.x1 * scale, y: pageHeight - segment.y1 * scale },
        end: { x: pageWidth - cornerWidth + segment.x2 * scale, y: pageHeight - segment.y2 * scale },
        thickness: 0.35, color: inkBlack,
      });
    }
    page.pushOperators(popGraphicsState());
    page.drawText('Page ' + pageNumber, { x: pageWidth - margin - 34, y: 26, size: 7, font: regular, color: muted });
    y = pageHeight - 45.35;
    if (pageNumber > 1) {
      for (const part of wrap(documentTitle + ' · ' + documentNumber, bold, 9, 300)) {
        page.drawText(part, { x: margin, y, size: 9, font: bold, color: inkBlack }); y -= 12;
      }
      y = Math.min(y - 18, pageHeight - 140);
    }
  };

  const ensure = (height: number) => {
    if (y - height < bodyBottom) startPage();
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

  // Match the preview: property trading name first, legal identity below.
  const mastheadTop = y;
  let logoWidth = 42;
  if (embeddedLogo) {
    const factor = Math.min(42 / embeddedLogo.height, 119 / embeddedLogo.width);
    logoWidth = embeddedLogo.width * factor;
    page.drawImage(embeddedLogo, { x: margin, y: mastheadTop - 42, width: logoWidth, height: embeddedLogo.height * factor });
  } else {
    page.drawRectangle({ x: margin, y: mastheadTop - 42, width: 42, height: 42, borderWidth: 0.5, borderColor: rgb(0.75, 0.75, 0.75) });
    const initials = propertyName.split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 3).join("").toUpperCase();
    const initialWidth = bold.widthOfTextAtSize(initials, 9);
    page.drawText(initials, { x: margin + (42 - initialWidth) / 2, y: mastheadTop - 25, size: 9, font: bold, color: inkBlack });
  }
  const mastheadX = margin + logoWidth + 12;
  y -= 15;
  for (const part of wrap(propertyName.toUpperCase(), bold, 16.5, Math.min(270, pageWidth - mastheadX - 185))) {
    draw(part, mastheadX, 16.5, bold, inkBlack); y -= 18;
  }
  y -= 1;
  for (const line of [organisation, taxLine, identity["registration_number"] ? 'Registration: ' + text(identity["registration_number"]) : ""].filter(Boolean)) {
    for (const part of wrap(line, regular, 7.5, 285)) { draw(part, mastheadX, 7.5, regular, muted); y -= 10; }
  }
  const titleTop = Math.min(y, mastheadTop - 42) - 30;
  const titleWidth = contentWidth - 245;
  page.drawRectangle({ x: margin, y: titleTop - 20, width: 85.04, height: 19.84, color: brown });
  const titleLines = wrap(documentTitle.toUpperCase(), bold, 22.5, titleWidth);
  titleLines.forEach((part, index) => page.drawText(part, { x: margin + 39.7, y: titleTop - 29 - index * 25, size: 22.5, font: bold, color: inkBlack }));
  const metaSource = payload.meta ?? {};
  const metaEntries: [string, string][] = [
    [documentTitle + ' no.', documentNumber], ["Date", dateLabel(payload.document?.date)],
    ["Status", text(payload.document?.status)], ["Currency", currency], ["Timezone", documentTimezone],
  ];
  for (const key of ["due_date", "reservation", "confirmation", "reference", "room", "stay"]) {
    const value = text(metaSource[key]); if (value) metaEntries.push([key.replace(/_/g, " "), value]);
  }
  const metaRight = pageWidth - margin;
  let metaY = Math.min(titleTop - 9, pageHeight - 128);
  metaEntries.filter(([,value])=>value).forEach(([label,value], index) => {
    const font = index === 0 ? bold : regular, size = index === 0 ? 9 : 8.25;
    for (const part of wrap(label + ': ' + value, font, size, 195)) {
      page.drawText(part, { x: metaRight - font.widthOfTextAtSize(part, size), y: metaY, size, font, color: inkBlack }); metaY -= 12;
    }
  });
  const trace = documentTraceCode({ organizationId: text(identity["organisation_id"]) || null,
    propertyId: branchId, documentType: type, documentNumber });
  if (trace) {
    metaY -= 3;
    page.drawText(trace, { x: metaRight - regular.widthOfTextAtSize(trace, 6), y: metaY,
      size: 6, font: regular, color: muted });
    metaY -= 8;
  }
  y = Math.min(titleTop - 29 - titleLines.length * 25, metaY) - 26;

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
  const showMoney = lines.some(
    (line) => line.unit_price !== undefined && line.unit_price !== null,
  );

  const fallbackColumns = showMoney
    ? [
        { key: "description", label: "Description", width: 232, align: "left" as const },
        { key: "quantity", label: "Qty", width: 56, align: "right" as const },
        { key: "unit_price", label: "Unit price", width: 90, align: "right" as const },
        { key: "tax", label: "Tax", width: 60, align: "right" as const },
        { key: "total", label: "Amount", width: 67, align: "right" as const },
      ]
    : [
        { key: "description", label: "Description", width: 300, align: "left" as const },
        { key: "quantity", label: "Qty", width: 80, align: "right" as const },
        { key: "note", label: "Detail", width: 125, align: "right" as const },
      ];

  let nextColumnX = margin;
  const configuredColumns = layout.columns ?? fallbackColumns;
  const columnScale = contentWidth / configuredColumns.reduce((sum, column) => sum + column.width, 0);
  const columns = configuredColumns.map((source) => {
    const column = { ...source, width: source.width * columnScale };
    const positioned = { ...column, x: nextColumnX };
    nextColumnX += column.width;
    return positioned;
  });
  const descriptionColumn =
    columns.find((column) => column.key === "description") ?? columns[0]!;
  const seenLabels = new Set<string>();
  const totals = (Array.isArray(payload.totals) ? payload.totals : []).filter((total) => {
    if (!total || total.amount === null || total.amount === undefined) return false;
    const key = text(total.label).toLowerCase();
    if (!key || seenLabels.has(key)) return false;
    seenLabels.add(key);
    return true;
  });
  const panelWidth = 240;
  const boxX = pageWidth - margin - panelWidth;
  const totalRows = documentTaxTotals(totals).map(({ row: total, tax }) => {
    const value = money(total.amount, currency);
    const size = total.emphasis ? 11 : 9;
    const font = total.emphasis ? bold : regular;
    const padding = total.emphasis ? 10 : 4;
    const valueWidth = font.widthOfTextAtSize(value, size);
    const labels = wrap(total.label, font, size, panelWidth - valueWidth - 2 * padding - 10);
    const lineHeight = size + 4;
    return { total, tax, value, size, font, padding, valueWidth, labels, lineHeight,
      height: Math.max(1, labels.length) * lineHeight + (total.emphasis ? 19 : 6) };
  });
  const summaryReserve = Math.min(220, totalRows.reduce((height, row) => height + row.height, 0));
  const drawHeader = () => {
    page.drawLine({ start: { x: margin, y: y - 6 }, end: { x: pageWidth - margin, y: y - 6 }, thickness: 0.6, color: tableRule });
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
  const startTablePage = () => { startPage(); drawHeader(); };

  if (lines.length) {
    ensure(60);
    drawHeader();
    for (const [lineIndex, line] of lines.entries()) {
      const cellFont = (key: string) => key === "total" ? bold : regular;
      const cellValue = (key: string) => {
        if (key === "number") return String(lineIndex + 1);
        if (key === "date") return dateLabel(line.date);
        if (key === "description") return text(line.description) || "—";
        if (key === "category") return text(line.category).replace(/_/g, " ");
        if (key === "quantity") return unitIsColumn ? quantity(line.quantity) : [quantity(line.quantity), text(line.unit)].filter(Boolean).join(" ");
        if (key === "unit") return text(line.unit);
        if (key === "unit_price") return money(line.unit_price, currency);
        if (key === "tax") return money(line.tax, currency);
        if (key === "total") return money(line.total, currency);
        return text(line.note);
      };
      const unitIsColumn = columns.some((column) => column.key === "unit");
      const cells = columns.map((column) => ({ column, font: cellFont(column.key), parts: wrap(cellValue(column.key), cellFont(column.key), 8.5, column.width - 8) }));
      const noteLines = !columns.some((column) => column.key === "note") && line.note ? wrap(text(line.note), regular, 7.5, descriptionColumn.width - 8) : [];
      const mainLines = Math.max(1, ...cells.map((cell) => cell.parts.length));
      const rowHeight = mainLines * 12 + noteLines.length * 10 + 10;
      const lastRowReserve = lineIndex === lines.length - 1 ? summaryReserve + 16 : 0;
      if (y - Math.min(rowHeight + lastRowReserve, pageHeight - bodyBottom - 168) < bodyBottom) startTablePage();
      for (let index = 0; index < mainLines; index++) {
        if (y - 16 < bodyBottom) startTablePage();
        for (const { column, font, parts } of cells) {
          const part = parts[index];
          if (!part) continue;
          page.drawText(part, {
            x: column.align === "right" ? column.x + column.width - 4 - font.widthOfTextAtSize(part, 8.5) : column.x,
            y, size: 8.5, font, color: inkBlack,
          });
        }
        y -= 12;
      }
      for (const note of noteLines) {
        if (y - 14 < bodyBottom) startTablePage();
        page.drawText(note, { x: descriptionColumn.x, y, size: 7.5, font: regular, color: muted });
        y -= 10;
      }
      y -= 10;
      page.drawLine({ start:{x:margin,y:y+6},end:{x:pageWidth-margin,y:y+6},thickness:0.35,dashArray:[1,2],color:rule });
    }
    y -= 16;
  }

  // ---- Totals: a right-aligned summary panel, total on a brand band ----
  // Each named figure appears once. A repeated label, or a second line that
  // merely restates the emphasised balance, is dropped so the band below is
  // the only place the amount owed is stated.
  if (totalRows.length) {
    ensure(summaryReserve + 18);
    draw("SUMMARY", boxX + 4, 8, bold, muted);
    y -= 16;
    let shownTaxHeading = false;
    for (const { total, tax, value, size, font, padding, valueWidth, labels, lineHeight, height } of totalRows) {
      if (tax && !shownTaxHeading) {
        ensure(height + 18);
        draw("TAX BREAKDOWN", boxX + 4, 8, bold, muted);
        y -= 17;
        shownTaxHeading = true;
      }
      ensure(height);
      const top = y - (total.emphasis ? 8 : 0);
      const colour = total.emphasis ? rgb(1, 1, 1) : inkBlack;
      if (total.emphasis) {
        page.drawRectangle({ x: boxX, y: y - height + 14, width: panelWidth, height: height - 10, color: brown });
      } else {
        page.drawRectangle({ x: boxX, y: y - height + 5, width: panelWidth, height, color: rgb(0.96, 0.97, 0.98) });
      }
      labels.forEach((label, index) => page.drawText(label, {
        x: boxX + padding, y: top - index * lineHeight, size, font, color: colour,
      }));
      page.drawText(value, { x: pageWidth - margin - padding - valueWidth, y: top, size, font, color: colour });
      y -= height;
    }
    y -= 8;
  }

  // ---- Payment information, terms and operational detail ----
  const shownInHeader = new Set(["due_date", "reservation", "confirmation", "reference", "room", "stay"]);
  const qrPayload = text(metaSource["qr_payload"]);
  const meta = Object.entries(payload.meta ?? {}).filter(
    ([label, value]) =>
      label !== "qr_payload" &&
      !shownInHeader.has(label) &&
      value !== null &&
      value !== "" &&
      value !== undefined,
  );
  if (meta.length) {
    ensure(40);
    draw("PAYMENT INFORMATION, TERMS & DETAIL", margin, 7.5, bold, muted);
    y -= 13;
    for (const [label, value] of meta) {
      const body = typeof value === "object" ? JSON.stringify(value) : String(value);
      const wrapped = wrap(`${label.replace(/_/g, " ")}: ${body}`, regular, 8.5, contentWidth);
      ensure(Math.min(wrapped.length * 11 + 6, 120));
      for (const part of wrapped) {
        ensure(14);
        draw(part, margin, 8.5, regular, dark);
        y -= 11;
      }
      y -= 2;
    }
    y -= 6;
  }

  if (qrPayload) {
    ensure(120);

    try {
      const qrDataUrl = await QRCode.toDataURL(qrPayload, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 220,
      });

      const encoded = qrDataUrl.split(",", 2)[1] ?? "";
      const qrBytes = Uint8Array.from(atob(encoded), (character) =>
        character.charCodeAt(0),
      );
      const qrImage = await pdf.embedPng(qrBytes);

      draw("KRA eTIMS VERIFICATION", margin, 7.5, bold, muted);
      y -= 98;

      page.drawImage(qrImage, {
        x: margin,
        y,
        width: 88,
        height: 88,
      });

      y -= 12;
    } catch {
      draw("KRA eTIMS QR could not be rendered.", margin, 8, regular, muted);
      y -= 12;
    }
  }

  // A real footer region, with the same three contact columns as the preview.
  let footerSymbol: Awaited<ReturnType<PDFDocument["embedPng"]>> | undefined;
  try {
    footerSymbol = await pdf.embedPng(Buffer.from(NEO_SYMBOL_BASE64,"base64"));
  } catch { /* Branding artwork never invalidates the document. */ }
  for (const footerPage of pdf.getPages()) {
  page = footerPage;
  page.drawLine({ start:{x:margin,y:footerTop},end:{x:pageWidth-margin,y:footerTop},thickness:0.6,color:brown });
  const contactColumns = [["Phone",text(property["phone"])],["Mail",text(property["email"])],["Address",addressParts]];
  contactColumns.forEach(([label,value],index)=>{
    const x=margin+index*(contentWidth/3);
    if (index === 0) {
      page.drawRectangle({ x: x + 2, y: footerTop - 23, width: 4.5, height: 9, borderWidth: 0.8, borderColor: inkBlack });
    } else if (index === 1) {
      page.drawRectangle({ x, y: footerTop - 22, width: 9, height: 6, borderWidth: 0.6, borderColor: inkBlack });
      page.drawLine({ start: { x, y: footerTop - 16 }, end: { x: x + 4.5, y: footerTop - 20 }, thickness: 0.5, color: inkBlack });
      page.drawLine({ start: { x: x + 9, y: footerTop - 16 }, end: { x: x + 4.5, y: footerTop - 20 }, thickness: 0.5, color: inkBlack });
    } else {
      page.drawCircle({ x: x + 4.5, y: footerTop - 18, size: 2.7, borderWidth: 1, borderColor: inkBlack });
      page.drawLine({ start: { x: x + 2.4, y: footerTop - 20 }, end: { x: x + 4.5, y: footerTop - 24 }, thickness: 0.7, color: inkBlack });
      page.drawLine({ start: { x: x + 6.6, y: footerTop - 20 }, end: { x: x + 4.5, y: footerTop - 24 }, thickness: 0.7, color: inkBlack });
    }
    page.drawText(label!,{x:x+13,y:footerTop-19,size:8.25,font:bold,color:inkBlack});
    wrap(value||"Not configured",regular,7.5,contentWidth/3-25).slice(0,4).forEach((part,line)=>page.drawText(part,{x:x+13,y:footerTop-31-line*10,size:7.5,font:regular,color:muted}));
  });
  const signature="Powered by NEØ",credit="Built by AI, Data & Marketing by Wambui";
  page.drawText(signature,{x:(pageWidth-regular.widthOfTextAtSize(signature,6.75))/2,y:58,size:6.75,font:regular,color:muted});
  page.drawText(credit,{x:(pageWidth-regular.widthOfTextAtSize(credit,6))/2,y:47,size:6,font:regular,color:muted});
  if (footerSymbol) page.drawImage(footerSymbol,{x:pageWidth-margin-26,y:39,width:26,height:26});
  }

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
