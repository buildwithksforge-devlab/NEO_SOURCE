import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const TYPES = new Set([
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
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const exportBusinessDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { type: string; id: string }) => {
    if (!TYPES.has(input.type)) throw new Error("Unknown document type.");
    if (!UUID.test(input.id)) throw new Error("Invalid document reference.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { buildBusinessDocumentPdf } = await import("@/lib/document-pdf.server");
    return buildBusinessDocumentPdf(context.supabase, {
      type: data.type as Parameters<typeof buildBusinessDocumentPdf>[1]["type"],
      id: data.id,
    });
  });

export const exportGuestBillDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { slug: string; id: string; kind: "folio" | "receipt" }) => {
    if (!/^[a-z0-9-]{1,80}$/.test(input.slug) || !UUID.test(input.id) ||
      (input.kind !== "folio" && input.kind !== "receipt")) throw new Error("Invalid guest document reference.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { fetchPublicProperty } = await import("@/lib/front-door");
    const { readFolioChargeComponents } = await import("@/lib/folio-charge-components");
    const { readSavedFolioTaxRows, renderBusinessDocumentPdf } = await import("@/lib/document-pdf.server");
    const hotel = await fetchPublicProperty(data.slug);
    if (!hotel?.publicly_listed || hotel.doors?.stay_dine === false) throw new Error("This property is unavailable.");
    const { data: bill, error } = await context.supabase.rpc("neo_guest_folio_projection" as never, {
      _org: hotel.organization_id, _branch: hotel.branch_id,
    } as never);
    if (error) throw new Error("Your billing documents could not be checked.");
    type Bill = { folios?: import("@/lib/guest-ordering").GuestFolio[]; payments?: import("@/lib/guest-ordering").GuestReceipt[] };
    const saved = bill as Bill | null;
    const property = {
      name: hotel.property_name,
      logo_url: hotel.media?.logo_url || hotel.logo_url,
      address: hotel.address,
      phone: hotel.phone,
      email: hotel.email,
      currency: hotel.currency,
    };
    const shared = {
      type: "folio_statement",
      party: {},
      identity: { organisation: hotel.property_name, organisation_id: hotel.organization_id },
      generated_at: new Date().toISOString(),
    };
    if (data.kind === "receipt") {
      const receipt = saved?.payments?.find((row) => row.id === data.id);
      if (!receipt?.receipt_number || receipt.amount == null || !Number.isFinite(Number(receipt.amount))) {
        throw new Error("This issued receipt is unavailable for your account.");
      }
      // The authenticated customer projection carries saved payment evidence;
      // require its property and confirmed status before using hotel branding.
      if (!hotel.branch_id || receipt.branch_id !== hotel.branch_id ||
          !["confirmed", "posted", "completed", "paid", "succeeded", "captured"].includes(receipt.status ?? "")) {
        throw new Error("This issued receipt is unavailable at this property.");
      }
      return renderBusinessDocumentPdf({
        ...shared, property: { ...property, currency: receipt.currency || property.currency },
        document: { title: "Payment receipt", number: receipt.receipt_number, date: receipt.paid_at },
        lines: [{ description: "Payment received", total: receipt.amount }],
        totals: [{ label: "Amount received", amount: receipt.amount, emphasis: true }],
        meta: { "Payment method": receipt.method },
      }, "folio_statement", hotel.branch_id);
    }
    const folio = saved?.folios?.find((row) => row.id === data.id);
    if (!folio?.folio_number) throw new Error("This folio is unavailable for your account.");
    const { chargeComponents } = readFolioChargeComponents(folio as unknown as Record<string, unknown>);
    return renderBusinessDocumentPdf({
      ...shared, property: { ...property, currency: folio.currency || property.currency },
      document: { title: "Folio statement", number: folio.folio_number, status: folio.status, date: folio.opened_at },
      lines: (folio.lines ?? []).map((line) => ({
        description: line.description || "Charge", date: line.posting_date, quantity: line.quantity,
        unit_price: line.unit_price, discount: line.discount_amount, tax: line.tax_amount, total: line.net_amount,
      })),
      totals: [
        { label: "Net charges", amount: folio.net_revenue },
        ...await readSavedFolioTaxRows(context.supabase, data.id, hotel.branch_id, Number(folio.tax)),
        { label: "Service charge", amount: folio.service_charge },
        ...chargeComponents.map(({ label, amount }) => ({ label, amount })),
        { label: "Gross billed", amount: folio.gross_obligation },
        { label: "Collected", amount: folio.collected },
        { label: "Outstanding", amount: folio.outstanding, emphasis: true },
      ],
      meta: {},
    }, "folio_statement", hotel.branch_id);
  });

export const exportPartnerPurchaseOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { branch: string; relationship: string; number: string }) => {
    if (!UUID.test(input.branch) || !UUID.test(input.relationship) ||
      typeof input.number !== "string" || !input.number.trim() || input.number.length>80) {
      throw new Error("Invalid purchase order reference.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { data: payload, error } = await context.supabase.rpc("neo_partner_lpo_payload" as never, {
      _branch: data.branch, _relationship: data.relationship, _number: data.number,
    } as never);
    if (error || !payload) throw new Error("This issued purchase order is unavailable for your account.");
    const { renderBusinessDocumentPdf } = await import("@/lib/document-pdf.server");
    return renderBusinessDocumentPdf(payload as Parameters<typeof renderBusinessDocumentPdf>[0], "purchase_order", data.branch);
  });
