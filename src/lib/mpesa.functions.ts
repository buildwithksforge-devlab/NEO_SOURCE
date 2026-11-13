import { mpesaResultApplied } from "@/lib/mpesa-application-result";
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
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: any; error: { message: string } | null }>;
  from: (t: string) => any;
};

async function holdExistingMpesaDispatch(
  client: Rpc,
  transactionId: string,
  organizationId: string,
): Promise<StkChargeResult | null> {
  const { data, error } = await client.rpc("neo_mpesa_claim_dispatch", {
    _transaction: transactionId,
    _organization: organizationId,
  });
  if (error || typeof data?.claimed !== "boolean") {
    return {
      ok: false,
      status: "dispatch-blocked",
      detail:
        "The payment could not be safely dispatched. Check the server connection and payment migration installation before retrying.",
      transactionId,
    };
  }
  if (data.claimed) return null;
  return {
    ok: true,
    status: data.status === "initiated" ? "pending" : String(data.status ?? "unknown"),
    detail:
      "This payment attempt already exists. No additional prompt was sent. Check its collection status before retrying.",
    transactionId,
    reused: true,
  };
}

function existingMpesaCollection(started: Record<string, any>): StkChargeResult {
  return {
    ok: true,
    status: started["status"] === "unknown" ? "unknown" : "pending",
    detail:
      "A collection is already in progress. No additional prompt was sent. Check the existing attempt before retrying.",
    transactionId: String(started["transaction_id"]),
    amount: Number(started["amount"]),
    reused: true,
  };
}

async function recordMpesaPrompt(
  client: Rpc,
  transactionId: string,
  fields: Record<string, unknown>,
): Promise<StkChargeResult | null> {
  const { error } = await client
    .from("mpesa_transactions")
    .update(fields)
    .eq("id", transactionId)
    .is("applied_at", null);
  if (!error) return null;
  return {
    ok: true,
    status: "unknown",
    transactionId,
    detail:
      "Safaricom accepted the request but its tracking details could not be saved. Do not send another prompt; check the phone and Recent collections.",
  };
}

async function retainAmbiguousMpesaPrompt(
  client: Rpc,
  transactionId: string,
  detail: string,
): Promise<void> {
  const { error } = await client
    .from("mpesa_transactions")
    .update({
      status: "unknown",
      result_desc: detail,
      failure_detail: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", transactionId);
  if (error) throw new Error(`Could not retain the ambiguous M-Pesa prompt: ${error.message}`);
}

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
  const env = (process.env["PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (env) return env.replace(/\/+$/, "");
  return (await requestOrigin()).replace(/\/+$/, "");
}

import { checkCallbackBase, isTemporaryHost } from "./mpesa-callback";
export { checkCallbackBase, isTemporaryHost };

function callbackUrl(base: string, token: string): string {
  return `${base}/api/public/mpesa/callback/${token}`;
}

async function organisationOf(client: Rpc, userId: string): Promise<string | null> {
  const profile = await client
    .from("profiles")
    .select("organization_id")
    .eq("id", userId)
    .maybeSingle();
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
      settings.short_code &&
      settings.has_consumer_key &&
      settings.has_consumer_secret &&
      settings.has_passkey,
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
          : settings.environment === "production" &&
              settings.enabled &&
              configuredBase &&
              !temporary
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
  .inputValidator(
    (input: {
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
      transactionType: input?.transactionType
        ? String(input.transactionType).trim()
        : "CustomerPayBillOnline",
      consumerKey: input?.consumerKey ? String(input.consumerKey).trim() : null,
      consumerSecret: input?.consumerSecret ? String(input.consumerSecret).trim() : null,
      passkey: input?.passkey ? String(input.passkey).trim() : null,
      callbackBaseUrl: input?.callbackBaseUrl ? String(input.callbackBaseUrl).trim() : null,
      enabled: Boolean(input?.enabled),
      clearSecrets: Boolean(input?.clearSecrets),
      rotateToken: Boolean(input?.rotateToken),
    }),
  )
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
  .inputValidator(
    (input?: {
      environment?: string;
      consumerKey?: string | null;
      consumerSecret?: string | null;
    }) => ({
      environment:
        input?.environment === "production"
          ? ("production" as const)
          : input?.environment === "sandbox"
            ? ("sandbox" as const)
            : null,
      consumerKey: input?.consumerKey ? String(input.consumerKey).trim() : null,
      consumerSecret: input?.consumerSecret ? String(input.consumerSecret).trim() : null,
    }),
  )
  .handler(async ({ data, context }) => {
    const client = context.supabase as unknown as Rpc;
    const { data: settings, error } = await client.rpc("neo_mpesa_settings_get");
    if (error) throw new Error(error.message);
    if (!settings?.authorised) {
      return {
        authorised: false as const,
        ok: false,
        status: "unauthorised",
        detail: settings?.reason ?? "Not permitted.",
      };
    }

    const organizationId = await organisationOf(client, context.userId);
    if (!organizationId) {
      return {
        authorised: true as const,
        ok: false,
        status: "no-organisation",
        detail: "No organisation is linked to this account.",
      };
    }

    const { darajaToken, loadMpesaCredentials } = await import("@/lib/mpesa.server");
    // A complete draft OAuth test needs no privileged database read. Keep it
    // usable when saved-secret access is unavailable, and never record a draft
    // result as verification of the saved configuration.
    const completeDraft = Boolean(data.consumerKey && data.consumerSecret);
    const saved = completeDraft ? null : await loadMpesaCredentials(organizationId);
    const environment = data.environment ?? saved?.environment ?? settings.environment ?? "sandbox";
    const environmentChanged = Boolean(saved && environment !== saved.environment);
    if (environmentChanged && (!data.consumerKey || !data.consumerSecret)) {
      return {
        authorised: true as const,
        ok: false,
        status: "credentials-required",
        detail:
          "Enter the Consumer Key and Consumer Secret for the selected environment before testing.",
      };
    }

    const consumerKey = data.consumerKey ?? saved?.consumerKey;
    const consumerSecret = data.consumerSecret ?? saved?.consumerSecret;
    if (!consumerKey || !consumerSecret) {
      const detail =
        "Enter the Consumer Key and Consumer Secret before testing. The test does not save them.";
      return { authorised: true as const, ok: false, status: "incomplete", detail };
    }

    const started = Date.now();
    const result = await darajaToken({ environment, consumerKey, consumerSecret });
    const detail = result.ok ? "Daraja issued an access token." : result.detail;
    const usingSavedConfiguration = Boolean(
      saved &&
      !environmentChanged &&
      (data.consumerKey === null || data.consumerKey === saved.consumerKey) &&
      (data.consumerSecret === null || data.consumerSecret === saved.consumerSecret),
    );
    if (usingSavedConfiguration) {
      await client.rpc("neo_mpesa_record_check", {
        _status: result.ok ? "ok" : result.status,
        _detail: detail,
      });
    }
    return {
      authorised: true as const,
      ok: result.ok,
      status: result.ok ? "ok" : result.status,
      detail: usingSavedConfiguration
        ? detail
        : `${detail} This draft test did not save or change settings.`,
      environment,
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
  reused?: boolean;
  amount?: number;
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
    if (!(data.amount > 0))
      return { ok: false, status: "invalid", detail: "Enter an amount greater than zero." };

    const { loadMpesaCredentials, normaliseMsisdn, stkPush } = await import("@/lib/mpesa.server");
    const msisdn = normaliseMsisdn(data.msisdn);
    if (!msisdn)
      return { ok: false, status: "invalid", detail: "Enter a valid Kenyan mobile number." };

    const organizationId = await organisationOf(client, context.userId);
    if (!organizationId)
      return {
        ok: false,
        status: "no-organisation",
        detail: "No organisation is linked to this account.",
      };

    const creds = await loadMpesaCredentials(organizationId);
    if (!creds || !creds.enabled) {
      return {
        ok: false,
        status: "not-configured",
        detail: "M-Pesa is not configured or is switched off for this workspace.",
      };
    }
    const base = await baseUrl(creds.callbackBaseUrl);
    if (!base) {
      return {
        ok: false,
        status: "no-callback",
        detail: "Set the public callback base URL in M-Pesa settings first.",
      };
    }

    // Create/reuse the payment and provider transaction in one locked operation.
    const { data: started, error } = await client.rpc("neo_mpesa_collection_start", {
      _source_module: data.sourceModule,
      _source_record: data.sourceRecordId,
      _msisdn: msisdn,
      _amount: data.amount,
      _description: data.description,
    });
    if (error || !started?.transaction_id)
      return {
        ok: false,
        status: "rejected",
        detail: error?.message ?? "Payment creation was not confirmed.",
      };
    if (started.reused) return existingMpesaCollection(started);
    const transactionId = String(started["transaction_id"]);
    const accountReference = String(started.account_reference ?? creds.accountReference ?? "NEO");

    // 3. Push the prompt, then record what the provider said.
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = admin as unknown as Rpc;
    const held = await holdExistingMpesaDispatch(
      supabaseAdmin,
      transactionId,
      creds.organizationId,
    );
    if (held) return held;
    const push = await stkPush(creds, {
      msisdn,
      amount: data.amount,
      accountReference,
      description: data.description ?? "NEO payment",
      callbackUrl: callbackUrl(base, creds.callbackToken),
    });

    if (!push.ok) {
      if (push.status === "ambiguous") {
        await retainAmbiguousMpesaPrompt(supabaseAdmin, String(transactionId), push.detail);
        return {
          ok: true,
          status: "unknown",
          detail: push.detail,
          transactionId: transactionId as string,
        };
      }
      await supabaseAdmin.rpc("neo_mpesa_apply_result", {
        _transaction: transactionId,
        _result_code: -1,
        _result_desc: push.detail,
        _receipt: null,
        _transaction_date: null,
        _payload: { error: push.detail, status: push.status },
        _source: "push-error",
      });
      return {
        ok: false,
        status: push.status,
        detail: push.detail,
        transactionId: transactionId as string,
      };
    }

    const tracking = await recordMpesaPrompt(supabaseAdmin, transactionId, {
      status: "pending",
      merchant_request_id: push.data.MerchantRequestID ?? null,
      checkout_request_id: push.data.CheckoutRequestID ?? null,
      raw_request: push.data.request,
      result_desc: push.data.CustomerMessage ?? push.data.ResponseDescription ?? null,
      updated_at: new Date().toISOString(),
    });
    if (tracking) return tracking;

    return {
      ok: true,
      status: "pending",
      detail:
        push.data.CustomerMessage ?? "Prompt sent. Ask the customer to enter their M-Pesa PIN.",
      transactionId: transactionId as string,
      checkoutRequestId: push.data.CheckoutRequestID ?? undefined,
      customerMessage: push.data.CustomerMessage ?? undefined,
    };
  });

/** Asks Daraja for the current state of a prompt and applies the outcome. */
export const reconcileMpesaTransaction = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { transactionId: string }) => ({
    transactionId: String(input?.transactionId ?? "").trim(),
  }))
  .handler(async ({ data, context }) => {
    const client = context.supabase as unknown as Rpc;
    if (!data.transactionId)
      return { ok: false, status: "invalid", detail: "No transaction supplied." };

    const existing = await client
      .from("mpesa_transactions")
      .select("*")
      .eq("id", data.transactionId)
      .maybeSingle();
    const row = existing?.data as Record<string, any> | null;
    if (!row) return { ok: false, status: "not-found", detail: "Transaction not visible to you." };
    if (
      !(await client.rpc("neo_mpesa_can_collect", { _source_module: row["source_module"] })).data
    ) {
      return { ok: false, status: "unauthorised", detail: "You cannot reconcile this payment." };
    }
    if (row["applied_at"]) {
      return {
        ok: true,
        status: row["status"] as string,
        detail: "Already reconciled.",
        duplicate: true,
      };
    }
    if (!row["checkout_request_id"]) {
      return {
        ok: false,
        status: "no-reference",
        detail:
          "No Safaricom checkout reference was saved, so this attempt cannot be queried automatically. Check the phone and Recent collections before sending another prompt.",
      };
    }

    const { loadMpesaCredentials, stkQuery, darajaResultCode } = await import("@/lib/mpesa.server");
    const creds = await loadMpesaCredentials(row["organization_id"] as string);
    if (!creds)
      return { ok: false, status: "not-configured", detail: "M-Pesa credentials are incomplete." };

    const query = await stkQuery(creds, String(row["checkout_request_id"]));
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = admin as unknown as Rpc;
    await supabaseAdmin
      .from("mpesa_transactions")
      .update({ last_query_at: new Date().toISOString() })
      .eq("id", data.transactionId);

    if (!query.ok) return { ok: false, status: query.status, detail: query.detail };

    const code = darajaResultCode(query.data.ResultCode);
    if (code === null) {
      return {
        ok: false,
        status: "unknown",
        detail: query.data.ResultDesc ?? "Safaricom returned no result code yet.",
      };
    }
    if ((query.data.CheckoutRequestID && query.data.CheckoutRequestID !== row["checkout_request_id"]) || (query.data.MerchantRequestID && row["merchant_request_id"] && query.data.MerchantRequestID !== row["merchant_request_id"])) {
      return {ok:false,status:"verification-mismatch",detail:"Daraja returned a different transaction reference. No payment was applied."};
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
    if (error || !mpesaResultApplied(applied, code)) return { ok: false, status: "apply-failed", detail: "The database did not confirm application of this provider result. Keep the existing transaction for reconciliation." };
    return {
      ok: true,
      status: (applied?.status as string) ?? "unknown",
      detail: query.data.ResultDesc ?? "",
    };
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
    if (!msisdn)
      return { ok: false, status: "invalid", detail: "Enter a valid Kenyan mobile number." };

    const { verifyMpesaServerAccess } = await import("@/lib/mpesa.server");
    await verifyMpesaServerAccess();
    const { data: started, error } = await client.rpc("neo_delivery_guest_mpesa_start", {
      _order: data.orderId,
      _msisdn: msisdn,
    });
    if (error) return { ok: false, status: "rejected", detail: error.message };
    if (started?.already_paid)
      return { ok: true, status: "paid", detail: "This order is already paid." };
    if (!started?.transaction_id) {
      return {
        ok: false,
        status: started?.pending ? "pending" : "no-balance",
        detail: started?.pending
          ? "A collection is already pending for this order. Check its status before sending another prompt."
          : "There is nothing left to pay on this order.",
      };
    }

    const creds = await loadMpesaCredentials(String(started.organization_id));
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = admin as unknown as Rpc;
    const transactionId = String(started["transaction_id"]);

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

    const held = await holdExistingMpesaDispatch(
      supabaseAdmin,
      transactionId,
      creds.organizationId,
    );
    if (held) return held;
    const push = await stkPush(creds, {
      msisdn,
      amount: Number(started["amount"]),
      accountReference: String(started.account_reference ?? "NEO"),
      description: "Delivery order",
      callbackUrl: callbackUrl(base, creds.callbackToken),
    });
    if (!push.ok) {
      if (push.status === "ambiguous") {
        await retainAmbiguousMpesaPrompt(supabaseAdmin, transactionId, push.detail);
        return { ok: true, status: "unknown", detail: push.detail, transactionId };
      }
      return fail(push.status, push.detail);
    }

    const tracking = await recordMpesaPrompt(supabaseAdmin, transactionId, {
      status: "pending",
      merchant_request_id: push.data.MerchantRequestID ?? null,
      checkout_request_id: push.data.CheckoutRequestID ?? null,
      raw_request: push.data.request,
      result_desc: push.data.CustomerMessage ?? push.data.ResponseDescription ?? null,
      updated_at: new Date().toISOString(),
    });
    if (tracking) return tracking;

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
  .inputValidator(
    (input: { organizationId: string; folioId: string; msisdn: string; amount?: number }) => ({
      organizationId: String(input?.organizationId ?? ""),
      folioId: String(input?.folioId ?? ""),
      msisdn: String(input?.msisdn ?? ""),
      amount: input?.amount,
    }),
  )
  .handler(async ({ data, context }): Promise<DeliveryChargeResult> => {
    const client = context.supabase as unknown as Rpc;
    const { loadMpesaCredentials, normaliseMsisdn, stkPush } = await import("@/lib/mpesa.server");
    const msisdn = normaliseMsisdn(data.msisdn);
    if (!msisdn)
      return { ok: false, status: "invalid", detail: "Enter a valid Kenyan mobile number." };
    const { verifyMpesaServerAccess } = await import("@/lib/mpesa.server");
    await verifyMpesaServerAccess();
    const { data: started, error } = await client.rpc("neo_mpesa_collection_start", {
      _source_module: "guest_folio",
      _organization: data.organizationId,
      _source_record: data.folioId,
      _msisdn: msisdn,
      _amount: data.amount ?? null,
    });
    if (error || !started?.transaction_id)
      return {
        ok: false,
        status: "rejected",
        detail: error?.message ?? "The payment could not be started.",
      };
    if (started.reused) return existingMpesaCollection(started);
    const creds = await loadMpesaCredentials(data.organizationId);
    const transactionId = String(started["transaction_id"]);
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = admin as unknown as Rpc;
    const fail = async (status: string, detail: string) => {
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
    if (!creds || !creds.enabled)
      return fail("not-configured", "M-Pesa is not available for this property right now.");
    const base = await baseUrl(creds.callbackBaseUrl);
    if (!base) return fail("no-callback", "M-Pesa is not fully set up for this property yet.");
    const held = await holdExistingMpesaDispatch(
      supabaseAdmin,
      transactionId,
      creds.organizationId,
    );
    if (held) return held;
    const push = await stkPush(creds, {
      msisdn,
      amount: Number(started["amount"]),
      accountReference: String(started.folio_number ?? "FOLIO"),
      description: "Guest folio",
      callbackUrl: callbackUrl(base, creds.callbackToken),
    });
    if (!push.ok) {
      if (push.status === "ambiguous") {
        await retainAmbiguousMpesaPrompt(supabaseAdmin, transactionId, push.detail);
        return { ok: true, status: "unknown", detail: push.detail, transactionId };
      }
      return fail(push.status, push.detail);
    }
    const tracking = await recordMpesaPrompt(supabaseAdmin, transactionId, {
      merchant_request_id: push.data.MerchantRequestID,
      checkout_request_id: push.data.CheckoutRequestID,
      status: "pending",
      updated_at: new Date().toISOString(),
    });
    if (tracking) return tracking;
    return {
      ok: true,
      status: "pending",
      detail: "Payment request sent. Approve it on your phone.",
      transactionId,
    };
  });

/** Booking deposit equivalent: fixes the old UI which created a DB transaction but never sent STK. */
export const chargeGuestDepositWithMpesa = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: { organizationId: string; reference: string; msisdn: string; amount?: number }) => ({
      organizationId: String(input?.organizationId ?? ""),
      reference: String(input?.reference ?? ""),
      msisdn: String(input?.msisdn ?? ""),
      amount: input?.amount,
    }),
  )
  .handler(async ({ data, context }): Promise<DeliveryChargeResult> => {
    const client = context.supabase as unknown as Rpc;
    const { loadMpesaCredentials, normaliseMsisdn, stkPush } = await import("@/lib/mpesa.server");
    const msisdn = normaliseMsisdn(data.msisdn);
    if (!msisdn)
      return { ok: false, status: "invalid", detail: "Enter a valid Kenyan mobile number." };
    const { verifyMpesaServerAccess } = await import("@/lib/mpesa.server");
    await verifyMpesaServerAccess();
    const { data: started, error } = await client.rpc("neo_mpesa_guest_deposit_start", {
      _org: data.organizationId,
      _reference: data.reference,
      _msisdn: msisdn,
      _amount: data.amount ?? null,
    });
    if (error || !started?.transaction_id)
      return {
        ok: false,
        status: "rejected",
        detail: error?.message ?? "The deposit could not be started.",
      };
    if (started.reused) return existingMpesaCollection(started);
    const creds = await loadMpesaCredentials(data.organizationId);
    const transactionId = String(started["transaction_id"]);
    const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
    const supabaseAdmin = admin as unknown as Rpc;
    const fail = async (status: string, detail: string) => {
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
    if (!creds || !creds.enabled)
      return fail("not-configured", "M-Pesa is not available for this property right now.");
    const base = await baseUrl(creds.callbackBaseUrl);
    if (!base) return fail("no-callback", "M-Pesa is not fully set up for this property yet.");
    const held = await holdExistingMpesaDispatch(
      supabaseAdmin,
      transactionId,
      creds.organizationId,
    );
    if (held) return held;
    const push = await stkPush(creds, {
      msisdn,
      amount: Number(started["amount"]),
      accountReference: data.reference,
      description: "Booking deposit",
      callbackUrl: callbackUrl(base, creds.callbackToken),
    });
    if (!push.ok) {
      if (push.status === "ambiguous") {
        await retainAmbiguousMpesaPrompt(supabaseAdmin, transactionId, push.detail);
        return {
          ok: true,
          status: "unknown",
          detail: push.detail,
          transactionId,
          amount: Number(started["amount"]),
        };
      }
      return fail(push.status, push.detail);
    }
    const tracking = await recordMpesaPrompt(supabaseAdmin, transactionId, {
      merchant_request_id: push.data.MerchantRequestID,
      checkout_request_id: push.data.CheckoutRequestID,
      status: "pending",
      updated_at: new Date().toISOString(),
    });
    if (tracking) return tracking;
    return {
      ok: true,
      status: "pending",
      detail: "Payment request sent. Approve it on your phone.",
      transactionId,
      amount: Number(started["amount"]),
    };
  });
