import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const TYPES = new Set([
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
