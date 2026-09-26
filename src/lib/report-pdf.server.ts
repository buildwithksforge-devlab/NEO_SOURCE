import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

type ReportPdfInput = {
  title: string;
  branchId: string | null;
  from: string;
  to: string;
  paths: string[];
};

type FactDefinition = { label: string; kind: string; eligibility: string };

const FACT_DEFINITIONS: Record<string, FactDefinition> = {
  "rooms.occupancy_rate": { label: "Occupancy", kind: "percent", eligibility: "Occupied room nights divided by available room nights." },
  "rooms.occupied_room_nights": { label: "Occupied room nights", kind: "count", eligibility: "Room nights attached to eligible in-house or completed stays." },
  "rooms.available_room_nights": { label: "Available room nights", kind: "count", eligibility: "Sellable room inventory after out-of-order exclusions." },
  "rooms.adr": { label: "Average daily rate", kind: "money", eligibility: "Eligible room revenue divided by occupied room nights." },
  "rooms.revpar": { label: "Revenue per available room", kind: "money", eligibility: "Eligible room revenue divided by available room nights." },
  "front_office.arrivals_today": { label: "Arrivals today", kind: "count", eligibility: "Reservations due to arrive on the property business date." },
  "front_office.departures_today": { label: "Departures today", kind: "count", eligibility: "In-house stays due to depart on the property business date." },
  "front_office.in_house": { label: "Guests in house", kind: "count", eligibility: "Active checked-in stays in the selected scope." },
  "front_office.rooms_out_of_order": { label: "Rooms out of order", kind: "count", eligibility: "Rooms actively blocked from sale by an operational condition." },
  "operational.room_folio_revenue": { label: "Room folio revenue", kind: "money", eligibility: "Eligible room charges posted to guest folios in the period." },
  "operational.pos_finalised_sales": { label: "Finalised point-of-sale sales", kind: "money", eligibility: "Finalised restaurant and bar sales; drafts and open bills are excluded." },
  "operational.delivery_sales": { label: "Delivery sales", kind: "money", eligibility: "Delivered orders eligible for operational reporting." },
  "operational.other_folio_revenue": { label: "Other folio revenue", kind: "money", eligibility: "Eligible non-room charges posted to guest folios." },
  "accounting.net_recognised_revenue": { label: "Net recognised revenue", kind: "money", eligibility: "Posted accounting revenue less posted reversals." },
  "collections.total": { label: "Collections", kind: "money", eligibility: "Payments collected in the selected period." },
  "receivables.total": { label: "Receivables", kind: "money", eligibility: "Outstanding eligible customer and guest balances." },
  "receivables.invoices_overdue": { label: "Overdue invoices", kind: "count", eligibility: "Open invoices past their due date." },
  "events.confirmed_forecast": { label: "Confirmed event forecast", kind: "money", eligibility: "Confirmed event value; forecast only, not recognised revenue." },
  "events.invoiced": { label: "Event invoiced", kind: "money", eligibility: "Event value represented by issued invoices." },
};

const MONEY_PATHS = new Set([
  "operational.room_folio_revenue", "operational.pos_finalised_sales", "operational.delivery_sales",
  "operational.other_folio_revenue", "accounting.net_recognised_revenue", "collections.total",
  "receivables.total", "ops.restaurant.sales_today", "ops.restaurant.open_value",
  "ops.finance.payments_today", "events.confirmed_forecast", "events.invoiced",
  "ops.events.deposits_received", "ops.events.outstanding_balance", "ops.inventory.valuation",
]);

const definitionFor = (path: string): FactDefinition => FACT_DEFINITIONS[path] ?? {
  label: path.split(".").at(-1)?.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase()) ?? path,
  kind: MONEY_PATHS.has(path) ? "money" : "count",
  eligibility: "Value returned by the authoritative scoped operational fact service.",
};

const valueAt = (payload: Record<string, unknown>, path: string): unknown =>
  path.split(".").reduce<unknown>((value, key) =>
    value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null, payload);

const safeHex = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;

const colour = (hex: string) => rgb(
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
);

const wrap = (text: string, font: PDFFont, size: number, width: number) => {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else { if (line) lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
};

export async function buildManagementReportPdf(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: ReportPdfInput,
): Promise<{ filename: string; base64: string }> {
  const { data: canExport } = await supabase.rpc("has_permission", {
    _module: "reports", _feature: "*", _action: "export",
  });
  if (canExport !== true) throw new Error("You do not have permission to export reports.");

  const factArgs = input.branchId
    ? { _branch: input.branchId, _from: input.from, _to: input.to }
    : { _from: input.from, _to: input.to };
  const [periodResult, frontOfficeResult, operationalResult, profileResult] = await Promise.all([
    supabase.rpc("neo_facts", factArgs),
    supabase.rpc("neo_front_office_facts", input.branchId ? { _branch: input.branchId } : {}),
    supabase.rpc("neo_operational_facts", input.branchId ? { _branch: input.branchId } : {}),
    supabase.from("profiles").select("organization_id").eq("id", userId).maybeSingle(),
  ]);
  const { data: facts, error: factError } = periodResult;
  const { data: frontOffice, error: frontOfficeError } = frontOfficeResult;
  const { data: operational, error: operationalError } = operationalResult;
  const { data: profile, error: profileError } = profileResult;
  if (factError) throw new Error(factError.message);
  if (frontOfficeError) throw new Error(frontOfficeError.message);
  if (operationalError) throw new Error(operationalError.message);
  if (profileError || !profile?.organization_id) throw new Error("No organisation is configured for this account.");

  const [{ data: organization }, { data: settings }, branchResult] = await Promise.all([
    supabase.from("organizations").select("name, legal_name").eq("id", profile.organization_id).maybeSingle(),
    supabase.from("organization_settings").select("brand, regional").eq("organization_id", profile.organization_id).maybeSingle(),
    input.branchId
      ? supabase.from("branches").select("name, logo_url, branding").eq("id", input.branchId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const factPayload = {
    ...((facts ?? {}) as Record<string, unknown>),
    front_office: frontOffice ?? {},
    ops: operational ?? {},
  } as Record<string, unknown>;
  if (factPayload["authorised"] === false) throw new Error("You are not authorised to view this report.");
  const moneyAllowed = factPayload["monetary_authorised"] === true;
  const brand = (settings?.brand ?? {}) as Record<string, unknown>;
  const regional = (settings?.regional ?? {}) as Record<string, unknown>;
  const branch = branchResult.data as { name?: string; logo_url?: string | null; branding?: unknown } | null;
  const branchBrand = (branch?.branding ?? {}) as Record<string, unknown>;
  const organisationName = organization?.name || organization?.legal_name || "Organisation not configured";
  const propertyName = branch?.name ?? "All authorised properties";
  const primaryHex = safeHex(branchBrand["primaryColor"] ?? brand["primaryColor"], "#18C4C8");
  const darkHex = safeHex(branchBrand["secondaryColor"] ?? brand["secondaryColor"], "#020A1C");
  const logoUrl = branch?.logo_url || (brand["logoLight"] as string | undefined) || (brand["logoDark"] as string | undefined);
  const currency = String((factPayload["scope"] as Record<string, unknown> | undefined)?.["currency"] ?? regional["currency"] ?? "");

  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageSize: [number, number] = [595.28, 841.89];
  const margin = 48;
  const primary = colour(primaryHex);
  const dark = colour(darkHex);
  let page: PDFPage = pdf.addPage(pageSize);
  let y = 0;
  let pageNumber = 0;

  let embeddedLogo: Awaited<ReturnType<PDFDocument["embedPng"]>> | null = null;
  if (logoUrl && /^https?:\/\//.test(logoUrl)) {
    try {
      const response = await fetch(logoUrl);
      if (response.ok) {
        const bytes = await response.arrayBuffer();
        embeddedLogo = /png/i.test(response.headers.get("content-type") ?? logoUrl)
          ? await pdf.embedPng(bytes)
          : await pdf.embedJpg(bytes);
      }
    } catch { embeddedLogo = null; }
  }

  const addPage = () => {
    page = pdf.addPage(pageSize);
    pageNumber += 1;
    const [width, height] = pageSize;
    page.drawRectangle({ x: 0, y: height - 18, width, height: 18, color: dark });
    page.drawRectangle({ x: 0, y: height - 22, width, height: 4, color: primary });
    page.drawText(String(organisationName), { x: margin, y: height - 52, size: 10, font: bold, color: dark });
    page.drawText(`Page ${pageNumber}`, { x: width - margin - 36, y: 28, size: 8, font: regular, color: rgb(0.38, 0.4, 0.44) });
    if (embeddedLogo) {
      const scaled = embeddedLogo.scale(32 / embeddedLogo.height);
      page.drawImage(embeddedLogo, { x: width - margin - scaled.width, y: height - 67, width: scaled.width, height: 32 });
    }
    y = height - 90;
  };
  const ensure = (height: number) => { if (y - height < 54) addPage(); };
  const drawLines = (text: string, x: number, size: number, font: PDFFont, width: number, shade = dark) => {
    for (const line of wrap(text, font, size, width)) {
      page.drawText(line, { x, y, size, font, color: shade });
      y -= size + 4;
    }
  };

  pdf.removePage(0);
  addPage();
  drawLines(input.title.slice(0, 100), margin, 23, bold, 410);
  y -= 4;
  drawLines(`${propertyName}  |  ${input.from} to ${input.to}`, margin, 10, regular, 490, rgb(0.35, 0.38, 0.42));
  y -= 18;

  const rows = input.paths
    .map((path) => ({ path, definition: definitionFor(path), value: valueAt(factPayload, path) }))
    .filter((row): row is { path: string; definition: FactDefinition; value: unknown } =>
      Boolean(row.definition && (row.definition.kind !== "money" || moneyAllowed)));

  for (const row of rows) {
    ensure(68);
    page.drawLine({ start: { x: margin, y: y + 8 }, end: { x: pageSize[0] - margin, y: y + 8 }, thickness: 0.5, color: rgb(0.82, 0.84, 0.87) });
    drawLines(row.definition.label, margin, 10, bold, 300);
    const value = row.value === null || row.value === undefined
      ? "Awaiting data"
      : row.definition.kind === "money"
        ? `${currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(Number(row.value))}`
        : row.definition.kind === "percent" ? `${Number(row.value).toFixed(1)}%` : String(row.value);
    page.drawText(value, { x: 390, y: y + 14, size: 11, font: bold, color: primary });
    drawLines(row.definition.eligibility, margin, 8, regular, 470, rgb(0.38, 0.4, 0.44));
    y -= 12;
  }

  if (rows.length === 0) drawLines("No reportable values are available for this scope.", margin, 11, regular, 480);
  y -= 8;
  ensure(70);
  page.drawRectangle({ x: margin, y: y - 38, width: pageSize[0] - margin * 2, height: 48, color: rgb(0.95, 0.97, 0.97) });
  page.drawText("Governance", { x: margin + 12, y: y - 6, size: 9, font: bold, color: dark });
  page.drawText("Generated from the permission-scoped canonical fact layer. Unknown values are not replaced with zero.", {
    x: margin + 12, y: y - 22, size: 7.5, font: regular, color: rgb(0.34, 0.37, 0.4),
  });

  pdf.setTitle(`${input.title} — ${organisationName}`);
  pdf.setAuthor(String(organisationName));
  pdf.setSubject(`Management report for ${propertyName}, ${input.from} to ${input.to}`);
  pdf.setCreationDate(new Date());
  const bytes = await pdf.save();
  const filename = `${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${input.from}-${input.to}.pdf`;
  return { filename, base64: Buffer.from(bytes).toString("base64") };
}
