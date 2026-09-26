/**
 * M-Pesa (Daraja) typed RPC.
 *
 * Configuration reads/writes go through guarded database routines, so authority
 * lives in the database. Collections create the module's own pending payment
 * first (POS or folio), then push the STK prompt; the provider result is applied
 * by the verified webhook or by an explicit reconciliation here.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rpc = {
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<{ data: any; error: { message: string } | null }>;
  from: (t: string) => any;
};

export type MpesaSettings = {
  authorised: boolean;
  reason?: string;
  configured?: boolean;
  environment?: "sandbox" | "production";
  short_code?: string | null;
  party_b?: string | null;
  account_reference?: string | null;
  transaction_type?: string;
  enabled?: boolean;
  has_consumer_key?: boolean;
  has_consumer_secret?: boolean;
  has_passkey?: boolean;
  callback_token?: string | null;
  callback_base_url?: string | null;
  last_check_at?: string | null;
  last_check_status?: string | null;
  last_check_detail?: string | null;
  callback_url?: string | null;
  /** Where the callback address came from: typed in, this site, or nowhere. */
  callback_source?: "configured" | "this-site" | "none";
  /** True when the address belongs to a preview / development site. */
  callback_temporary?: boolean;
  /** not-configured → configured → tested → production-ready. */
  status?: "not-configured" | "configured" | "tested" | "production-ready";
  production_ready?: boolean;
};

export type SaveResult = {
  authorised: boolean;
  saved?: boolean;
  complete?: boolean;
  enabled?: boolean;
  enable_blocked?: boolean;
  missing?: string[];
  reason?: string;
};

/** The public origin this workspace is served from — used when no base URL was configured. */
async function requestOrigin(): Promise<string> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const url = getRequest()?.url;
    return url ? new URL(url).origin : "";
  } catch {
    return "";
  }
}

async function baseUrl(fromSettings: string | null | undefined): Promise<string> {
  const configured = (fromSettings ?? "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const env = (process.env["PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "").trim().replace(/\/+$/, "");
  if (env) return env.replace(/\/+$/, "");
  return (await requestOrigin()).replace(/\/+$/, "");
}



import { checkCallbackBase, isTemporaryHost } from "./mpesa-callback";
export { checkCallbackBase, isTemporaryHost };

function callbackUrl(base: string, token: string): string {
  return `${base}/api/public/mpesa/callback/${token}`;
}

async function organisationOf(client: Rpc, userId: string): Promise<string | null> {
  const profile = await client.from("profiles").select("organization_id").eq("id", userId).maybeSingle();
  return (profile?.data?.organization_id as string | undefined) ?? null;
}

export const getMpesaSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MpesaSettings> => {
    const client = context.supabase as unknown as Rpc;
    const { data, error } = await client.rpc("neo_mpesa_settings_get");
    if (error) throw new Error(error.message);
    const settings = (data ?? { authorised: false }) as MpesaSettings;
    if (!settings.authorised) return settings;
    const configuredBase = (settings.callback_base_url ?? "").trim();
    const base = await baseUrl(settings.callback_base_url);
    const url = base && settings.callback_token ? callbackUrl(base, settings.callback_token) : null;
    const temporary = Boolean(url) && isTemporaryHost(url as string);
    const credentialsStored = Boolean(
      settings.short_code && settings.has_consumer_key && settings.has_consumer_secret && settings.has_passkey,
    );
    const tested = settings.last_check_status === "ok";
    return {
      ...settings,
      callback_url: url,
      callback_source: configuredBase ? "configured" : url ? "this-site" : "none",
      callback_temporary: temporary,
      // Four distinct things, never collapsed into one "connected" badge.
      status: !credentialsStored
        ? "not-configured"
        : !tested
          ? "configured"
          : settings.environment === "production" && settings.enabled && configuredBase && !temporary
            ? "production-ready"
            : "tested",
      production_ready:
        credentialsStored &&
        tested &&
        settings.environment === "production" &&
        Boolean(settings.enabled) &&
        Boolean(configuredBase) &&
        !temporary,
    };
  });

export const saveMpesaSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: {
    environment: string;
    shortCode?: string | null;
    partyB?: string | null;
    accountReference?: string | null;
    transactionType?: string | null;
    consumerKey?: string | null;
    consumerSecret?: string | null;
    passkey?: string | null;
    callbackBaseUrl?: string | null;
    enabled?: boolean;
    clearSecrets?: boolean;
    rotateToken?: boolean;
  }) => ({
    environment: String(input?.environment ?? "sandbox").trim(),
    shortCode: input?.shortCode ? String(input.shortCode).trim() : null,
    partyB: input?.partyB ? String(input.partyB).trim() : null,
    accountReference: input?.accountReference ? String(input.accountReference).trim() : null,
    transactionType: input?.transactionType ? String(input.transactionType).trim() : "CustomerPayBillOnline",
    consumerKey: input?.consumerKey ? String(input.consumerKey).trim() : null,
    consumerSecret: input?.consumerSecret ? String(input.consumerSecret).trim() : null,
    passkey: input?.passkey ? String(input.passkey).trim() : null,
    callbackBaseUrl: input?.callbackBaseUrl ? String(input.callbackBaseUrl).trim() : null,
    enabled: Boolean(input?.enabled),
    clearSecrets: Boolean(input?.clearSecrets),
    rotateToken: Boolean(input?.rotateToken),
  }))
  .handler(async ({ data, context }) => {
    const client = context.supabase as unknown as Rpc;

    // A typed address is checked before it is stored — a bad one would only
    // show up later as confirmations that never arrive.
    const callback = checkCallbackBase(data.callbackBaseUrl);
    if (!callback.ok) {
      return { authorised: true, saved: false, reason: callback.problem } as SaveResult;
    }

    // Live collections may not depend on a guessed or temporary address.
    let enabled = data.enabled;
    let enableBlocked: string | null = null;
    if (enabled && data.environment === "production") {
      if (!callback.value) {
        enableBlocked =
          "Enter the public callback address of your live site before switching production collections on.";
      } else if (isTemporaryHost(callback.value)) {
        enableBlocked =
          "That callback address belongs to a temporary preview site. Use your published address for live collections.";
      }
      if (enableBlocked) enabled = false;
    }

    const { data: result, error } = await client.rpc("neo_mpesa_settings_save", {
      _environment: data.environment,
      _short_code: data.shortCode,
      _party_b: data.partyB,
      _account_reference: data.accountReference,
      _transaction_type: data.transactionType,
      _consumer_key: data.consumerKey,
      _consumer_secret: data.consumerSecret,
      _passkey: data.passkey,
      _callback_base_url: callback.value,
      _enabled: enabled,
      _clear_secrets: data.clearSecrets,
      _rotate_token: data.rotateToken,
    });
    if (error) throw new Error(error.message);
    const saved = (result ?? { authorised: false }) as SaveResult;
    if (enableBlocked && saved.saved) {
      return { ...saved, enabled: false, enable_blocked: true, reason: enableBlocked };
    }
    return saved;
  });

/** Proves the stored credentials can obtain a Daraja access token. */
export const testMpesaConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const client = context.supabase as unknown as Rpc;
    const { data: settings, error } = await client.rpc("neo_mpesa_settings_get");
    if (error) throw new Error(error.message);
    if (!settings?.authorised) {
      return { authorised: false as const, ok: false, status: "unauthorised", detail: settings?.reason ?? "Not permitted." };
    }

    const organizationId = await organisationOf(client, context.userId);
    if (!organizationId) {
      return { authorised: true as const, ok: false, status: "no-organisation", detail: "No organisation is linked to this account." };
    }

    const { loadMpesaCredentials, darajaToken } = await import("@/lib/mpesa.server");
    const creds = await loadMpesaCredentials(organizationId);
    if (!creds) {
      const detail = "Paybill/till, consumer key, consumer secret and passkey are all required before testing.";
      await client.rpc("neo_mpesa_record_check", { _status: "incomplete", _detail: detail });
      return { authorised: true as const, ok: false, status: "incomplete", detail };
    }

    const started = Date.now();
    const result = await darajaToken(creds);
    const detail = result.ok ? "Daraja issued an access token." : result.detail;
    await client.rpc("neo_mpesa_record_check", {
      _status: result.ok ? "ok" : result.status,
      _detail: detail,
    });
    return {
      authorised: true as const,
      ok: result.ok,
      status: result.ok ? "ok" : result.status,
      detail,
      environment: creds.environment,
      duration_ms: Date.now() - started,
    };
  });

export type StkChargeInput = {
  sourceModule: "pos_order" | "folio";
  sourceRecordId: string;
  msisdn: string;
  amount: number;
  description?: string | null;
};

export type StkChargeResult = {
  ok: boolean;
  status: string;
  detail: string;
  transactionId?: string | undefined;
  checkoutRequestId?: string | undefined;
  customerMessage?: string | undefined;
};

/**
 * Sends an STK prompt for a restaurant bill or a guest folio. The pending
 * payment is created by the module's own routine, so balance and authority
 * rules are unchanged; only confirmation is delegated to the provider.
 */
export const chargeWithMpesa = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: StkChargeInput) => ({
    sourceModule: input?.sourceModule === "folio" ? ("folio" as const) : ("pos_order" as const),
    sourceRecordId: String(input?.sourceRecordId ?? "").trim(),
    msisdn: String(input?.msisdn ?? "").trim(),
    amount: Number(input?.amount ?? 0),
    description: input?.description ? String(input.description).trim().slice(0, 60) : null,
  }))
  .handler(async ({ data, context }): Promise<StkChargeResult> => {
    const client = context.supabase as unknown as Rpc;
    if (!data.sourceRecordId) return { ok: false, status: "invalid", detail: "Nothing to charge." };
    if (!(data.amount > 0)) return { ok: false, status: "invalid", detail: "Enter an amount greater than zero." };

    const { loadMpesaCredentials, normaliseMsisdn, stkPush } = await import("@/lib/mpesa.server");
    const msisdn = normaliseMsisdn(data.msisdn);
    if (!msisdn) return { ok: false, status: "invalid", detail: "Enter a valid Kenyan mobile number." };

    const organizationId = await organisationOf(client, context.userId);
    if (!organizationId) return { ok: false, status: "no-organisation", detail: "No organisation is linked to this account." };

    const creds = await loadMpesaCredentials(organizationId);
    if (!creds || !creds.enabled) {
      return { ok: false, status: "not-configured", detail: "M-Pesa is not configured or is switched off for this workspace." };
    }
    const base = await baseUrl(creds.callbackBaseUrl);
    if (!base) {
      return { ok: false, status: "no-callback", detail: "Set the public callback base URL in M-Pesa settings first." };
    }

    // 1. Pending payment through the module's existing authority checks.
    const providerReference = `STK-${crypto.randomUUID().slice(0, 12).toUpperCase()}`;
    let paymentId: string | null = null;
    let paymentTable: "pos_payments" | "payments";
    let branchId: string | null = null;
    let accountReference = creds.accountReference ?? "NEO";

    if (data.sourceModule === "pos_order") {
      paymentTable = "pos_payments";
      const order = await client.from("pos_orders").select("id, branch_id, order_number").eq("id", data.sourceRecordId).maybeSingle();
      if (!order?.data) return { ok: false, status: "not-found", detail: "Bill not found." };
      branchId = (order.data.branch_id as string | null) ?? null;
      accountReference = String(order.data.order_number ?? accountReference);
      const { data: attempt, error } = await client.rpc("pos_record_payment_attempt", {
        _order_id: data.sourceRecordId,
        _amount: data.amount,
        _method: "mpesa",
        _tendered: null,
        _reference: providerReference,
        _shift_id: null,
        _idempotency_key: `mpesa:${providerReference}`,
        _manual_confirm: false,
        _note: null,
      });
      if (error) return { ok: false, status: "rejected", detail: error.message };
      paymentId = (attempt?.payment_id as string | undefined) ?? null;
    } else {
      paymentTable = "payments";
      const folio = await client.from("folios").select("id, branch_id, folio_number").eq("id", data.sourceRecordId).maybeSingle();
      if (!folio?.data) return { ok: false, status: "not-found", detail: "Folio not found." };
      branchId = (folio.data.branch_id as string | null) ?? null;
      accountReference = String(folio.data.folio_number ?? accountReference);
      const { data: payment, error } = await client.rpc("pms_record_payment", {
        _folio: data.sourceRecordId,
        _amount: data.amount,
        _method: "mpesa",
        _reference: providerReference,
        _notes: "M-Pesa STK prompt sent to guest",
        // The provider reference is the collection intent: a re-sent prompt
        // reuses the same receipt instead of opening a second one.
        _intent_key: `mpesa:${providerReference}`,
      });
      if (error) return { ok: false, status: "rejected", detail: error.message };
      paymentId = (payment as string | null) ?? null;
    }

    // 2. Ledger row for the prompt.
    const { data: transactionId, error: txnError } = await client.rpc("neo_mpesa_txn_start", {
      _source_module: data.sourceModule,
      _source_record: data.sourceRecordId,
      _payment_table: paymentTable,
      _payment_id: paymentId,
      _branch: branchId,
      _msisdn: msisdn,
      _amount: data.amount,
      _account_reference: accountReference,
      _description: data.description ?? "NEO payment",
    });
    if (txnError) return { ok: false, status: "rejected", detail: txnError.message };

    // 3. Push the prompt, then record what the provider said.
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = admin as unknown as Rpc;
    const push = await stkPush(creds, {
      msisdn,
      amount: data.amount,
      accountReference,
      description: data.description ?? "NEO payment",
      callbackUrl: callbackUrl(base, creds.callbackToken),
    });

    if (!push.ok) {
      await supabaseAdmin.rpc("neo_mpesa_apply_result", {
        _transaction: transactionId,
        _result_code: -1,
        _result_desc: push.detail,
        _receipt: null,
        _transaction_date: null,
        _payload: { error: push.detail, status: push.status },
        _source: "push-error",
      });
      return { ok: false, status: push.status, detail: push.detail, transactionId: transactionId as string };
    }

    await supabaseAdmin
      .from("mpesa_transactions")
      .update({
        status: "pending",
        merchant_request_id: push.data.MerchantRequestID ?? null,
        checkout_request_id: push.data.CheckoutRequestID ?? null,
        raw_request: push.data.request,
        result_desc: push.data.CustomerMessage ?? push.data.ResponseDescription ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", transactionId);

    return {
      ok: true,
      status: "pending",
      detail: push.data.CustomerMessage ?? "Prompt sent. Ask the customer to enter their M-Pesa PIN.",
      transactionId: transactionId as string,
      checkoutRequestId: push.data.CheckoutRequestID ?? undefined,
      customerMessage: push.data.CustomerMessage ?? undefined,
    };
  });

/** Asks Daraja for the current state of a prompt and applies the outcome. */
export const reconcileMpesaTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { transactionId: string }) => ({ transactionId: String(input?.transactionId ?? "").trim() }))
  .handler(async ({ data, context }) => {
    const client = context.supabase as unknown as Rpc;
    if (!data.transactionId) return { ok: false, status: "invalid", detail: "No transaction supplied." };

    const existing = await client.from("mpesa_transactions").select("*").eq("id", data.transactionId).maybeSingle();
    const row = existing?.data as Record<string, any> | null;
    if (!row) return { ok: false, status: "not-found", detail: "Transaction not visible to you." };
    if (!(await client.rpc("neo_mpesa_can_collect", { _source_module: row["source_module"] })).data) {
      return { ok: false, status: "unauthorised", detail: "You cannot reconcile this payment." };
    }
    if (row["applied_at"]) {
      return { ok: true, status: row["status"] as string, detail: "Already reconciled.", duplicate: true };
    }
    if (!row["checkout_request_id"]) {
      return { ok: false, status: "no-reference", detail: "The prompt never reached Safaricom, so there is nothing to query." };
    }

    const { loadMpesaCredentials, stkQuery } = await import("@/lib/mpesa.server");
    const creds = await loadMpesaCredentials(row["organization_id"] as string);
    if (!creds) return { ok: false, status: "not-configured", detail: "M-Pesa credentials are incomplete." };

    const query = await stkQuery(creds, String(row["checkout_request_id"]));
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = admin as unknown as Rpc;
    await supabaseAdmin
      .from("mpesa_transactions")
      .update({ last_query_at: new Date().toISOString() })
      .eq("id", data.transactionId);

    if (!query.ok) return { ok: false, status: query.status, detail: query.detail };

    const code = query.data.ResultCode === undefined ? null : Number(query.data.ResultCode);
    if (code === null) {
      return { ok: false, status: "unknown", detail: query.data.ResultDesc ?? "Safaricom returned no result code yet." };
    }
    // 1032/1037 and friends are terminal; anything else non-zero is a decline.
    const { data: applied, error } = await supabaseAdmin.rpc("neo_mpesa_apply_result", {
      _transaction: data.transactionId,
      _result_code: code,
      _result_desc: query.data.ResultDesc ?? "",
      _receipt: null,
      _transaction_date: null,
      _payload: query.data as unknown as Record<string, unknown>,
      _source: "status-query",
    });
    if (error) return { ok: false, status: "apply-failed", detail: error.message };
    return { ok: true, status: (applied?.status as string) ?? "unknown", detail: query.data.ResultDesc ?? "" };
  });

export type DeliveryChargeResult = {
  ok: boolean;
  status: string;
  detail: string;
  transactionId?: string | undefined;
  amount?: number | undefined;
};

/**
 * A guest paying for their own delivery order with M-Pesa.
 *
 * The database routine proves the order belongs to the caller, opens the
 * pending payment and the provider transaction; only then is the prompt sent.
 * Nothing here marks the order paid — that happens when Safaricom's verified
 * callback (or the status query) applies the result.
 */
export const chargeDeliveryWithMpesa = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { orderId: string; msisdn: string }) => ({
    orderId: String(input?.orderId ?? "").trim(),
    msisdn: String(input?.msisdn ?? "").trim(),
  }))
  .handler(async ({ data, context }): Promise<DeliveryChargeResult> => {
    const client = context.supabase as unknown as Rpc;
    if (!data.orderId) return { ok: false, status: "invalid", detail: "No order supplied." };

    const { loadMpesaCredentials, normaliseMsisdn, stkPush } = await import("@/lib/mpesa.server");
    const msisdn = normaliseMsisdn(data.msisdn);
    if (!msisdn) return { ok: false, status: "invalid", detail: "Enter a valid Kenyan mobile number." };

    const { data: started, error } = await client.rpc("neo_delivery_guest_mpesa_start", {
      _order: data.orderId,
      _msisdn: msisdn,
    });
    if (error) return { ok: false, status: "rejected", detail: error.message };
    if (started?.already_paid) return { ok: true, status: "paid", detail: "This order is already paid." };
    if (!started?.transaction_id) {
      return { ok: false, status: "no-balance", detail: "There is nothing left to pay on this order." };
    }

    const creds = await loadMpesaCredentials(String(started.organization_id));
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = admin as unknown as Rpc;
    const transactionId = String(started.transaction_id);

    const fail = async (status: string, detail: string): Promise<DeliveryChargeResult> => {
      await supabaseAdmin.rpc("neo_mpesa_apply_result", {
        _transaction: transactionId,
        _result_code: -1,
        _result_desc: detail,
        _receipt: null,
        _transaction_date: null,
        _payload: { error: detail, status },
        _source: "push-error",
      });
      return { ok: false, status, detail, transactionId };
    };

    if (!creds || !creds.enabled) {
      return fail("not-configured", "M-Pesa is not available for this property right now.");
    }
    const base = await baseUrl(creds.callbackBaseUrl);
    if (!base) {
      return fail("no-callback", "M-Pesa is not fully set up for this property yet.");
    }

    const push = await stkPush(creds, {
      msisdn,
      amount: Number(started.amount),
      accountReference: String(started.account_reference ?? "NEO"),
      description: "Delivery order",
      callbackUrl: callbackUrl(base, creds.callbackToken),
    });
    if (!push.ok) return fail(push.status, push.detail);

    await supabaseAdmin
      .from("mpesa_transactions")
      .update({
        status: "pending",
        merchant_request_id: push.data.MerchantRequestID ?? null,
        checkout_request_id: push.data.CheckoutRequestID ?? null,
        raw_request: push.data.request,
        result_desc: push.data.CustomerMessage ?? push.data.ResponseDescription ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", transactionId);

    return {
      ok: true,
      status: "pending",
      detail: push.data.CustomerMessage ?? "Check your phone and enter your M-Pesa PIN to confirm.",
      transactionId,
    };
  });

/** Guest-owned folio M-Pesa checkout. Opens the pending payment in DB, then actually dispatches STK. */
export const chargeGuestFolioWithMpesa = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { organizationId: string; folioId: string; msisdn: string; amount?: number }) => ({
    organizationId: String(input?.organizationId ?? ""), folioId: String(input?.folioId ?? ""), msisdn: String(input?.msisdn ?? ""), amount: input?.amount,
  }))
  .handler(async ({ data, context }): Promise<DeliveryChargeResult> => {
    const client=context.supabase as unknown as Rpc;
    const { loadMpesaCredentials, normaliseMsisdn, stkPush }=await import("@/lib/mpesa.server");
    const msisdn=normaliseMsisdn(data.msisdn); if(!msisdn) return {ok:false,status:"invalid",detail:"Enter a valid Kenyan mobile number."};
    const {data:started,error}=await client.rpc("neo_guest_folio_mpesa_start",{_org:data.organizationId,_folio:data.folioId,_msisdn:msisdn,_amount:data.amount??null});
    if(error||!started?.transaction_id) return {ok:false,status:"rejected",detail:error?.message??"The payment could not be started."};
    const creds=await loadMpesaCredentials(data.organizationId); const transactionId=String(started.transaction_id);
    const {supabaseAdmin:admin}=await import("@/integrations/supabase/client.server"); const supabaseAdmin=admin as unknown as Rpc;
    const fail=async(status:string,detail:string)=>{await supabaseAdmin.rpc("neo_mpesa_apply_result",{_transaction:transactionId,_result_code:-1,_result_desc:detail,_receipt:null,_transaction_date:null,_payload:{error:detail,status},_source:"push-error"});return {ok:false,status,detail,transactionId};};
    if(!creds||!creds.enabled) return fail("not-configured","M-Pesa is not available for this property right now.");
    const base=await baseUrl(creds.callbackBaseUrl); if(!base) return fail("no-callback","M-Pesa is not fully set up for this property yet.");
    const push=await stkPush(creds,{msisdn,amount:Number(started.amount),accountReference:String(started.folio_number??"FOLIO"),description:"Guest folio",callbackUrl:callbackUrl(base,creds.callbackToken)});
    if(!push.ok) return fail(push.status,push.detail);
    await supabaseAdmin.from("mpesa_transactions").update({merchant_request_id:push.data.MerchantRequestID,checkout_request_id:push.data.CheckoutRequestID,status:"pending",updated_at:new Date().toISOString()}).eq("id",transactionId);
    return {ok:true,status:"pending",detail:"Payment request sent. Approve it on your phone.",transactionId};
  });

/** Booking deposit equivalent: fixes the old UI which created a DB transaction but never sent STK. */
export const chargeGuestDepositWithMpesa = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input:{organizationId:string;reference:string;msisdn:string;amount?:number})=>({organizationId:String(input?.organizationId??""),reference:String(input?.reference??""),msisdn:String(input?.msisdn??""),amount:input?.amount}))
  .handler(async({data,context}):Promise<DeliveryChargeResult>=>{
    const client=context.supabase as unknown as Rpc; const {loadMpesaCredentials,normaliseMsisdn,stkPush}=await import("@/lib/mpesa.server"); const msisdn=normaliseMsisdn(data.msisdn); if(!msisdn)return{ok:false,status:"invalid",detail:"Enter a valid Kenyan mobile number."};
    const {data:started,error}=await client.rpc("neo_guest_deposit_pay",{_org:data.organizationId,_reference:data.reference,_msisdn:msisdn,_amount:data.amount??null}); if(error||!started?.transaction_id)return{ok:false,status:"rejected",detail:error?.message??"The deposit could not be started."};
    const creds=await loadMpesaCredentials(data.organizationId); const transactionId=String(started.transaction_id); const {supabaseAdmin:admin}=await import("@/integrations/supabase/client.server"); const supabaseAdmin=admin as unknown as Rpc;
    const fail=async(status:string,detail:string)=>{await supabaseAdmin.rpc("neo_mpesa_apply_result",{_transaction:transactionId,_result_code:-1,_result_desc:detail,_receipt:null,_transaction_date:null,_payload:{error:detail,status},_source:"push-error"});return{ok:false,status,detail,transactionId};}; if(!creds||!creds.enabled)return fail("not-configured","M-Pesa is not available for this property right now."); const base=await baseUrl(creds.callbackBaseUrl); if(!base)return fail("no-callback","M-Pesa is not fully set up for this property yet.");
    const push=await stkPush(creds,{msisdn,amount:Number(started.amount),accountReference:data.reference,description:"Booking deposit",callbackUrl:callbackUrl(base,creds.callbackToken)}); if(!push.ok)return fail(push.status,push.detail); await supabaseAdmin.from("mpesa_transactions").update({merchant_request_id:push.data.MerchantRequestID,checkout_request_id:push.data.CheckoutRequestID,status:"pending",updated_at:new Date().toISOString()}).eq("id",transactionId); return{ok:true,status:"pending",detail:"Payment request sent. Approve it on your phone.",transactionId,amount:Number(started.amount)};
  });
