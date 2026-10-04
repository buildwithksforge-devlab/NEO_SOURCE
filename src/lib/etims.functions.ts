/**
 * KRA eTIMS typed RPC.
 *
 * Authority lives in the database: configuration is read and written through
 * guarded routines, and a document is only ever filed after the same routines
 * agree the caller may queue it. The KRA outcome is applied server-side, so an
 * invoice can never be marked fiscalised from the browser.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rpc = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
  from: (t: string) => any;
};

export type EtimsSettings = {
  authorised: boolean;
  reason?: string;
  configured?: boolean;
  environment?: "sandbox" | "production";
  mode?: "oscu" | "vscu";
  base_url?: string | null;
  kra_pin?: string | null;
  branch_code?: string | null;
  device_serial?: string | null;
  has_cmc_key?: boolean;
  has_api_key?: boolean;
  enabled?: boolean;
  auto_submit?: boolean;
  last_check_at?: string | null;
  last_check_status?: string | null;
  last_check_detail?: string | null;
};

async function organisationOf(client: Rpc, userId: string): Promise<string | null> {
  const profile = await client.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
  return (profile?.data?.organization_id as string | undefined) ?? null;
}

export const getEtimsSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<EtimsSettings> => {
    const client = context.supabase as unknown as Rpc;
    const { data, error } = await client.rpc("neo_etims_settings_get");
    if (error) throw new Error(error.message);
    return (data ?? { authorised: false }) as EtimsSettings;
  });

export const saveEtimsSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: {
    environment: string;
    mode: string;
    baseUrl?: string | null;
    kraPin?: string | null;
    branchCode?: string | null;
    deviceSerial?: string | null;
    cmcKey?: string | null;
    apiKey?: string | null;
    enabled?: boolean;
    autoSubmit?: boolean;
    clearSecrets?: boolean;
  }) => ({
    environment: String(input?.environment ?? "sandbox").trim(),
    mode: String(input?.mode ?? "oscu").trim(),
    baseUrl: input?.baseUrl ? String(input.baseUrl).trim() : null,
    kraPin: input?.kraPin ? String(input.kraPin).trim().toUpperCase() : null,
    branchCode: input?.branchCode ? String(input.branchCode).trim() : null,
    deviceSerial: input?.deviceSerial ? String(input.deviceSerial).trim() : null,
    cmcKey: input?.cmcKey ? String(input.cmcKey).trim() : null,
    apiKey: input?.apiKey ? String(input.apiKey).trim() : null,
    enabled: Boolean(input?.enabled),
    autoSubmit: input?.autoSubmit === undefined ? true : Boolean(input.autoSubmit),
    clearSecrets: Boolean(input?.clearSecrets),
  }))
  .handler(async ({ data, context }) => {
    const client = context.supabase as unknown as Rpc;
    const { data: result, error } = await client.rpc("neo_etims_settings_save", {
      _environment: data.environment,
      _mode: data.mode,
      _base_url: data.baseUrl,
      _kra_pin: data.kraPin,
      _branch_code: data.branchCode,
      _device_serial: data.deviceSerial,
      _cmc_key: data.cmcKey,
      _api_key: data.apiKey,
      _enabled: data.enabled,
      _auto_submit: data.autoSubmit,
      _clear_secrets: data.clearSecrets,
    });
    if (error) throw new Error(error.message);
    return (result ?? { authorised: false }) as { authorised: boolean; saved?: boolean; reason?: string };
  });

/** Proves the stored device credentials are recognised by KRA. */
export const testEtimsConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const client = context.supabase as unknown as Rpc;
    const { data: settings, error } = await client.rpc("neo_etims_settings_get");
    if (error) throw new Error(error.message);
    if (!settings?.authorised) {
      return { authorised: false as const, ok: false, detail: settings?.reason ?? "Not permitted." };
    }

    const organizationId = await organisationOf(client, context.userId);
    if (!organizationId) {
      return { authorised: true as const, ok: false, detail: "No organisation is linked to this account." };
    }

    const { loadEtimsCredentials, verifyDevice } = await import("@/lib/etims.server");
    const creds = await loadEtimsCredentials(organizationId);
    if (!creds) {
      const detail = "Service URL, KRA PIN, device serial and CMC key are all required before testing.";
      await client.rpc("neo_etims_record_check", { _status: "incomplete", _detail: detail });
      return { authorised: true as const, ok: false, detail };
    }

    const result = await verifyDevice(creds);
    await client.rpc("neo_etims_record_check", { _status: result.ok ? "ok" : "failed", _detail: result.detail });
    return { authorised: true as const, ok: result.ok, detail: result.detail };
  });

type FileInput = {
  invoiceId?: string | null;
  creditNoteId?: string | null;
  posOrderId?: string | null;
};

/**
 * Queues a document through the guarded routine, then files it with KRA and
 * records the outcome. Safe to call twice: the queue routine is idempotent per
 * document number and an already accepted document is never re-filed.
 */
export const fileTaxDocument = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: FileInput) => ({
    invoiceId: input?.invoiceId ? String(input.invoiceId) : null,
    creditNoteId: input?.creditNoteId ? String(input.creditNoteId) : null,
    posOrderId: input?.posOrderId ? String(input.posOrderId) : null,
  }))
  .handler(async ({ data, context }) => {
    const client = context.supabase as unknown as Rpc;
    if (!data.invoiceId && !data.creditNoteId && !data.posOrderId) {
      return { ok: false, status: "failed", detail: "Nothing to file." };
    }

    const { data: queued, error: queueError } = await client.rpc("neo_etims_queue_document", {
      _invoice: data.invoiceId,
      _credit_note: data.creditNoteId,
      _pos_order: data.posOrderId,
    });
    if (queueError) throw new Error(queueError.message);
    if (!queued?.queued) {
      return { ok: false, status: "failed", detail: queued?.reason ?? "The document could not be queued." };
    }

    const submissionId = String(queued.submission);

    // Already accepted by KRA — filing again would duplicate the fiscal receipt.
    const existing = await client
      .from("etims_submissions")
      .select("status, kra_reference")
      .eq("id", submissionId)
      .maybeSingle();
    if (existing?.data?.status === "accepted") {
      return {
        ok: true,
        status: "accepted",
        submissionId,
        detail: `Already filed with KRA${existing.data.kra_reference ? ` (${existing.data.kra_reference})` : ""}.`,
      };
    }

    const organizationId = await organisationOf(client, context.userId);
    if (!organizationId) {
      return { ok: false, status: "failed", submissionId, detail: "No organisation is linked to this account." };
    }

    const { loadEtimsCredentials, submitDocument } = await import("@/lib/etims.server");
    const creds = await loadEtimsCredentials(organizationId);
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = admin as unknown as Rpc;

    if (!creds || !creds.enabled) {
      const detail = "eTIMS credentials are incomplete or filing is switched off.";
      await supabaseAdmin.rpc("neo_etims_apply_result", {
        _submission: submissionId,
        _status: "failed",
        _error: detail,
        _response: { reason: "not-configured" },
      });
      return { ok: false, status: "failed", submissionId, detail };
    }

    // Assemble the document from server-side records only.
    const doc = await buildDocument(supabaseAdmin, submissionId);
    if (!doc) {
      const detail = "The document could not be assembled for filing.";
      await supabaseAdmin.rpc("neo_etims_apply_result", {
        _submission: submissionId,
        _status: "failed",
        _error: detail,
      });
      return { ok: false, status: "failed", submissionId, detail };
    }

    const result = await submitDocument(creds, doc);
    await supabaseAdmin.rpc("neo_etims_apply_result", {
      _submission: submissionId,
      _status: result.status,
      _kra_reference: result.kraReference ?? null,
      _control_unit_reference: result.controlUnitReference ?? null,
      _qr_payload: result.qrPayload ?? null,
      _error: result.ok ? null : result.detail,
      _request: result.request ?? {},
      _response: result.response ?? {},
    });

    return { ok: result.ok, status: result.status, submissionId, detail: result.detail };
  });

export const getPosFiscalStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { posOrderId: string }) => ({
    posOrderId: String(input.posOrderId),
  }))
  .handler(async ({ data, context }) => {
    const client = context.supabase as unknown as Rpc;
    const { data: result, error } = await client.rpc("neo_pos_etims_status", {
      _pos_order: data.posOrderId,
    });
    if (error) throw new Error(error.message);

    return (result ?? {
      found: false,
      status: "not_filed",
    }) as {
      found: boolean;
      status: string;
      submission_id?: string;
      kra_reference?: string;
      control_unit_reference?: string;
      error_details?: string;
    };
  });
/** Reads the invoice or credit note behind a submission and shapes it for KRA. */
async function buildDocument(admin: Rpc, submissionId: string) {
  const { data: submission } = await admin
    .from("etims_submissions")
    .select("id, document_kind, document_number, invoice_id, credit_note_id, pos_order_id")
    .eq("id", submissionId)
    .maybeSingle();
  if (!submission) return null;

  if (submission.invoice_id) {
    const { data: invoice } = await admin
      .from("invoices")
      .select("id, invoice_number, issue_date, currency, subtotal, tax_total, total, bill_to_snapshot")
      .eq("id", submission.invoice_id)
      .maybeSingle();
    if (!invoice) return null;
    const { data: lines } = await admin
      .from("invoice_lines")
      .select("line_number, description, quantity, unit_price, discount_amount, tax_rate, tax_amount, total_amount")
      .eq("invoice_id", invoice.id)
      .order("line_number");

    const billTo = (invoice.bill_to_snapshot ?? {}) as Record<string, unknown>;
    return {
      submissionId,
      documentKind: "invoice" as const,
      documentNumber: String(invoice.invoice_number),
      issueDate: String(invoice.issue_date),
      currency: String(invoice.currency ?? "KES"),
      customerName: String(billTo["name"] ?? billTo["full_name"] ?? "Walk-in customer"),
      customerPin: billTo["tax_pin"] ? String(billTo["tax_pin"]) : billTo["kra_pin"] ? String(billTo["kra_pin"]) : null,
      subtotal: Number(invoice.subtotal ?? 0),
      taxTotal: Number(invoice.tax_total ?? 0),
      total: Number(invoice.total ?? 0),
      lines: (lines ?? []).map((l: any, index: number) => ({
        lineNumber: Number(l.line_number ?? index + 1),
        description: String(l.description ?? "Item"),
        quantity: Number(l.quantity ?? 1),
        unitPrice: Number(l.unit_price ?? 0),
        discount: Number(l.discount_amount ?? 0),
        taxRate: Number(l.tax_rate ?? 0),
        taxAmount: Number(l.tax_amount ?? 0),
        total: Number(l.total_amount ?? 0),
      })),
    };
  }

  if (submission.pos_order_id) {
    const { data: order } = await admin
      .from("pos_orders")
      .select(
        "id, order_number, closed_at, created_at, currency, guest_name, subtotal, discount_total, tax_total, service_charge_total, grand_total",
      )
      .eq("id", submission.pos_order_id)
      .maybeSingle();

    if (!order) return null;

    const { data: lines } = await admin
      .from("pos_order_items")
      .select(
        "id, item_name, quantity, unit_price, discount_amount, tax_rate, tax_amount, line_total, status, created_at",
      )
      .eq("order_id", order.id)
      .neq("status", "voided")
      .order("created_at");

    const issueDate = String(order.closed_at ?? order.created_at ?? new Date().toISOString())
      .slice(0, 10);

    return {
      submissionId,
      documentKind: "pos_receipt" as const,
      documentNumber: String(order.order_number),
      issueDate,
      currency: String(order.currency ?? "KES"),
      customerName: String(order.guest_name ?? "Walk-in customer"),
      customerPin: null,

      // Fiscal amounts come directly from the posted POS transaction.
      // Do not rebuild or infer the sale from menu prices.
      subtotal: Number(order.subtotal ?? 0),
      taxTotal: Number(order.tax_total ?? 0),
      total: Number(order.grand_total ?? 0),

      lines: (lines ?? []).map((line: any, index: number) => ({
        lineNumber: index + 1,
        description: String(line.item_name ?? "Item"),
        quantity: Number(line.quantity ?? 1),
        unitPrice: Number(line.unit_price ?? 0),
        discount: Number(line.discount_amount ?? 0),
        taxRate: Number(line.tax_rate ?? 0),
        taxAmount: Number(line.tax_amount ?? 0),
        total: Number(line.line_total ?? 0),
      })),
    };
  }
  const { data: note } = await admin
    .from("credit_notes")
    .select("id, note_number, issue_date, currency, subtotal, tax_total, total, reason")
    .eq("id", submission.credit_note_id)
    .maybeSingle();
  if (!note) return null;

  return {
    submissionId,
    documentKind: "credit_note" as const,
    documentNumber: String(note.note_number),
    issueDate: String(note.issue_date ?? new Date().toISOString().slice(0, 10)),
    currency: String(note.currency ?? "KES"),
    customerName: "Credit note",
    customerPin: null,
    subtotal: Number(note.subtotal ?? 0),
    taxTotal: Number(note.tax_total ?? 0),
    total: Number(note.total ?? 0),
    lines: [
      {
        lineNumber: 1,
        description: String(note.reason ?? "Credit note"),
        quantity: 1,
        unitPrice: Number(note.total ?? 0),
        discount: 0,
        taxRate: Number(note.subtotal ?? 0) > 0 ? (Number(note.tax_total ?? 0) / Number(note.subtotal)) * 100 : 0,
        taxAmount: Number(note.tax_total ?? 0),
        total: Number(note.total ?? 0),
      },
    ],
  };
}
