/**
 * KRA eTIMS (OSCU/VSCU) client.
 *
 * Server-only. Credentials are read from the tenant's stored settings with the
 * service-role client and never leave this module. The KRA sales endpoint is
 * the same in both device modes; only the host differs, which the tenant sets.
 */

export type EtimsCredentials = {
  organizationId: string;
  environment: "sandbox" | "production";
  mode: "oscu" | "vscu";
  baseUrl: string;
  kraPin: string;
  branchCode: string;
  deviceSerial: string;
  cmcKey: string;
  apiKey: string | null;
  enabled: boolean;
  autoSubmit: boolean;
};

export type EtimsDocument = {
  submissionId: string;
  documentKind: "invoice" | "credit_note" | "debit_note" | "pos_receipt";
  documentNumber: string;
  issueDate: string;
  currency: string;
  customerName: string;
  customerPin: string | null;
  subtotal: number;
  taxTotal: number;
  total: number;
  lines: Array<{
    lineNumber: number;
    description: string;
    quantity: number;
    unitPrice: number;
    discount: number;
    taxRate: number;
    taxAmount: number;
    total: number;
  }>;
};

export type EtimsResult = {
  ok: boolean;
  status: "accepted" | "rejected" | "failed" | "retry_required";
  detail: string;
  kraReference?: string | null;
  controlUnitReference?: string | null;
  qrPayload?: string | null;
  request?: Record<string, unknown>;
  response?: Record<string, unknown>;
};

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Reads the tenant's eTIMS credentials. Returns null when setup is incomplete. */
export async function loadEtimsCredentials(organizationId: string): Promise<EtimsCredentials | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any)
    .from("etims_settings")
    .select("*")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error || !data) return null;

  const baseUrl = String(data.base_url ?? "").trim().replace(/\/+$/, "");
  const kraPin = String(data.kra_pin ?? "").trim();
  const deviceSerial = String(data.device_serial ?? "").trim();
  const cmcKey = String(data.cmc_key ?? "").trim();
  if (!baseUrl || !kraPin || !deviceSerial || !cmcKey) return null;

  return {
    organizationId,
    environment: data.environment === "production" ? "production" : "sandbox",
    mode: data.mode === "vscu" ? "vscu" : "oscu",
    baseUrl,
    kraPin,
    branchCode: String(data.branch_code ?? "00").trim() || "00",
    deviceSerial,
    cmcKey,
    apiKey: data.api_key ? String(data.api_key) : null,
    enabled: Boolean(data.enabled),
    autoSubmit: Boolean(data.auto_submit),
  };
}

function headers(creds: EtimsCredentials): Record<string, string> {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    tin: creds.kraPin,
    bhfId: creds.branchCode,
    cmcKey: creds.cmcKey,
  };
  if (creds.apiKey) base["Authorization"] = `Bearer ${creds.apiKey}`;
  return base;
}

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(
    date.getUTCMinutes(),
  )}${p(date.getUTCSeconds())}`;
}

/** Maps a NEØ tax rate onto the KRA tax band letters. */
export function taxBand(rate: number): "A" | "B" | "C" | "E" {
  if (rate >= 15.5) return "B"; // standard rate (16%)
  if (rate > 0) return "E"; // reduced/other rated
  return "A"; // exempt or zero rated
}

/** Builds the KRA sales payload for a document. */
export function buildSalesPayload(creds: EtimsCredentials, doc: EtimsDocument): Record<string, unknown> {
  const now = new Date();
  const sign = doc.documentKind === "credit_note" ? -1 : 1;

  return {
    tin: creds.kraPin,
    bhfId: creds.branchCode,
    invcNo: doc.documentNumber,
    orgInvcNo: doc.documentKind === "credit_note" ? doc.documentNumber : 0,
    custTin: doc.customerPin ?? null,
    custNm: doc.customerName,
    salesTyCd: "N",
    rcptTyCd: doc.documentKind === "credit_note" ? "R" : "S",
    pmtTyCd: "01",
    salesSttsCd: "02",
    cfmDt: stamp(now),
    salesDt: doc.issueDate.replace(/-/g, ""),
    totItemCnt: doc.lines.length,
    taxblAmtB: Number((sign * doc.subtotal).toFixed(2)),
    taxAmtB: Number((sign * doc.taxTotal).toFixed(2)),
    totTaxblAmt: Number((sign * doc.subtotal).toFixed(2)),
    totTaxAmt: Number((sign * doc.taxTotal).toFixed(2)),
    totAmt: Number((sign * doc.total).toFixed(2)),
    currency: doc.currency,
    regrId: creds.deviceSerial,
    regrNm: "NEO Hospitality OS",
    modrId: creds.deviceSerial,
    modrNm: "NEO Hospitality OS",
    itemList: doc.lines.map((line) => ({
      itemSeq: line.lineNumber,
      itemNm: line.description.slice(0, 200),
      pkgUnitCd: "NT",
      pkg: 1,
      qtyUnitCd: "U",
      qty: line.quantity,
      prc: line.unitPrice,
      splyAmt: Number((sign * (line.total - line.taxAmount)).toFixed(2)),
      dcAmt: line.discount,
      taxTyCd: taxBand(line.taxRate),
      taxblAmt: Number((sign * (line.total - line.taxAmount)).toFixed(2)),
      taxAmt: Number((sign * line.taxAmount).toFixed(2)),
      totAmt: Number((sign * line.total).toFixed(2)),
    })),
  };
}

async function post(creds: EtimsCredentials, path: string, body: Record<string, unknown>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(`${creds.baseUrl}${path}`, {
      method: "POST",
      headers: headers(creds),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text.slice(0, 2000) };
    }
    return { httpStatus: response.status, ok: response.ok, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

/** Confirms the device is initialised and reachable, without filing anything. */
export async function verifyDevice(creds: EtimsCredentials): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await post(creds, "/selectInitOsdcInfo", {
      tin: creds.kraPin,
      bhfId: creds.branchCode,
      dvcSrlNo: creds.deviceSerial,
    });
    const code = String(result.body?.resultCd ?? "");
    if (!result.ok) {
      return { ok: false, detail: `KRA responded ${result.httpStatus}: ${JSON.stringify(result.body).slice(0, 400)}` };
    }
    // 000 = success, 902 = already initialised — both prove the device is known.
    if (code === "000" || code === "902") {
      return { ok: true, detail: `Device recognised by KRA (${creds.environment}, ${creds.mode.toUpperCase()}).` };
    }
    return { ok: false, detail: `KRA rejected the device: ${result.body?.resultMsg ?? code}` };
  } catch (error) {
    return { ok: false, detail: `Could not reach the eTIMS endpoint: ${(error as Error).message}` };
  }
}

/** Files a sales document and interprets the KRA outcome. */
export async function submitDocument(creds: EtimsCredentials, doc: EtimsDocument): Promise<EtimsResult> {
  const payload = buildSalesPayload(creds, doc);
  try {
    const result = await post(creds, "/insertTrnsSalesOsdc", payload);
    const code = String(result.body?.resultCd ?? "");
    const message = String(result.body?.resultMsg ?? "");
    const data = result.body?.data ?? {};

    if (!result.ok) {
      return {
        ok: false,
        status: result.httpStatus >= 500 ? "retry_required" : "failed",
        detail: `KRA responded ${result.httpStatus}: ${message || JSON.stringify(result.body).slice(0, 300)}`,
        request: payload,
        response: result.body ?? {},
      };
    }

    if (code === "000") {
      return {
        ok: true,
        status: "accepted",
        detail: message || "Accepted by KRA.",
        kraReference: data.rcptNo ? String(data.rcptNo) : (data.curRcptNo ? String(data.curRcptNo) : null),
        controlUnitReference: data.intrlData ? String(data.intrlData) : null,
        qrPayload: data.rcptSign ? String(data.rcptSign) : (data.qrCodeUrl ? String(data.qrCodeUrl) : null),
        request: payload,
        response: result.body ?? {},
      };
    }

    return {
      ok: false,
      status: "rejected",
      detail: message ? `${code}: ${message}` : `KRA rejected the document (${code}).`,
      request: payload,
      response: result.body ?? {},
    };
  } catch (error) {
    return {
      ok: false,
      status: "retry_required",
      detail: `Could not reach the eTIMS endpoint: ${(error as Error).message}`,
      request: payload,
      response: {},
    };
  }
}
