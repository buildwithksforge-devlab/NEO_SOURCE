/**
 * Administration → M-Pesa (Daraja).
 *
 * Stores the tenant's Daraja credentials write-only, proves connectivity before
 * any live collection depends on them, and gives finance a reconciliation view
 * of every prompt sent from checkout and settlement.
 */
import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Copy, Loader2, PlugZap, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import {
  getMpesaSettings,
  saveMpesaSettings,
  testMpesaConnection,
  reconcileMpesaTransaction,
  type MpesaSettings,
} from "@/lib/mpesa.functions";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { PaymentReadinessPanel } from "@/components/payments/PaymentReadinessPanel";

export const Route = createFileRoute("/admin/payments-mpesa")({
  head: () => ({
    meta: [
      { title: "M-Pesa Payments — NEØ Administration" },
      {
        name: "description",
        content:
          "Connect Safaricom Daraja to NEØ: store paybill credentials securely, verify connectivity and reconcile every STK payment prompt.",
      },
      { property: "og:title", content: "M-Pesa Payments — NEØ Administration" },
      { property: "og:description", content: "Configure Safaricom Daraja and reconcile M-Pesa collections." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MpesaAdminPage,
});

const STATUS_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  success: "success",
  pending: "warning",
  initiated: "warning",
  failed: "destructive",
  cancelled: "destructive",
  timeout: "destructive",
};

type FailedCallback = {
  id: string;
  received_at: string;
  checkout_request_id: string | null;
  detail: string | null;
  transaction_id: string | null;
};

function MpesaAdminPage() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const load = useServerFn(getMpesaSettings);
  const save = useServerFn(saveMpesaSettings);
  const test = useServerFn(testMpesaConnection);
  const reconcile = useServerFn(reconcileMpesaTransaction);
  const queryClient = useQueryClient();

  const settings = useQuery<MpesaSettings>({ queryKey: ["mpesa-settings", filterKey], queryFn: () => load({ data: undefined as never }) });

  const [environment, setEnvironment] = useState("sandbox");
  const [shortCode, setShortCode] = useState("");
  const [partyB, setPartyB] = useState("");
  const [accountReference, setAccountReference] = useState("");
  const [transactionType, setTransactionType] = useState("CustomerPayBillOnline");
  const [callbackBaseUrl, setCallbackBaseUrl] = useState("");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [passkey, setPasskey] = useState("");
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const s = settings.data;
    if (!s?.authorised) return;
    setEnvironment(s.environment ?? "sandbox");
    setShortCode(s.short_code ?? "");
    setPartyB(s.party_b ?? "");
    setAccountReference(s.account_reference ?? "");
    setTransactionType(s.transaction_type ?? "CustomerPayBillOnline");
    setCallbackBaseUrl(s.callback_base_url ?? "");
    setEnabled(Boolean(s.enabled));
  }, [settings.data]);

  const transactions = useQuery({
    queryKey: ["mpesa-transactions", filterKey],
    enabled: Boolean(settings.data?.authorised),
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("mpesa_transactions").select("id, created_at, msisdn, amount, status, source_module, account_reference, mpesa_receipt_number, result_desc, applied_at"), "mpesa_transactions")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  /** Confirmations the provider sent that could not be posted, awaiting a safe re-apply. */
  const failedCallbacks = useQuery({
    queryKey: ["mpesa-failed-callbacks", filterKey],
    enabled: Boolean(settings.data?.authorised),
    refetchInterval: 30000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mpesa_callback_events")
        .select("id, received_at, checkout_request_id, detail, transaction_id")
        .eq("retryable", true)
        .is("resolved_at", null)
        .order("received_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      return (data ?? []) as FailedCallback[];
    },
  });

  const retryCallback = useMutation({
    mutationFn: async (eventId: string) => {
      const { data, error } = await guardedRpc(supabase, "neo_mpesa_retry_callback", {
        _event: eventId,
      });
      if (error) throw new Error(error.message);
      return (data ?? {}) as Record<string, unknown>;
    },
    onSuccess: (result) => {
      if (result["applied"]) toast.success("Payment re-applied to its transaction.");
      else toast.warning(String(result["reason"] ?? "The callback could not be re-applied."));
      void failedCallbacks.refetch();
      void transactions.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });


  const saveMutation = useMutation({
    mutationFn: async (rotateToken: boolean) =>
      save({
        data: {
          environment,
          shortCode,
          partyB,
          accountReference,
          transactionType,
          callbackBaseUrl,
          consumerKey: consumerKey || null,
          consumerSecret: consumerSecret || null,
          passkey: passkey || null,
          enabled,
          rotateToken,
        },
      }),
    onSuccess: (result) => {
      if (!result.authorised) {
        toast.error(result.reason ?? "Not permitted.");
        return;
      }
      if (!result.saved) {
        toast.error(result.reason ?? "Nothing was saved.");
        return;
      }
      setConsumerKey("");
      setConsumerSecret("");
      setPasskey("");
      // Everything typed is kept even when collections cannot be switched on
      // yet; the reply names exactly what is still missing.
      if (result.enable_blocked) {
        setEnabled(false);
        toast.warning(result.reason ?? "Saved, but collections stay switched off until the setup is complete.");
      } else {
        toast.success("M-Pesa settings saved");
      }
      void queryClient.invalidateQueries({ queryKey: ["mpesa-settings", filterKey] });
      void queryClient.invalidateQueries({ queryKey: ["mpesa-collection-status"] });
      void queryClient.invalidateQueries({ queryKey: ["payment-readiness"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const testMutation = useMutation({
    mutationFn: async () => test({ data: undefined as never }),
    onSuccess: (result) => {
      if (result.ok) toast.success(result.detail);
      else toast.error(result.detail);
      void queryClient.invalidateQueries({ queryKey: ["mpesa-settings", filterKey] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const reconcileMutation = useMutation({
    mutationFn: async (transactionId: string) => reconcile({ data: { transactionId } }),
    onSuccess: (result) => {
      if (result.ok) toast.success(`Provider status: ${result.status}`);
      else toast.error(result.detail);
      void queryClient.invalidateQueries({ queryKey: ["mpesa-transactions", filterKey] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (settings.isLoading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading M-Pesa settings…
      </div>
    );
  }

  if (!settings.data?.authorised) {
    return <AccessDeniedPanel subject="M-Pesa payment settings" detail={settings.data?.reason ?? "You do not have permission to configure M-Pesa."} />;
  }

  const s = settings.data;

  // Readiness is stated plainly: a prompt can only be sent once every one of
  // these is in place, so a half-saved connection never looks finished.
  const readiness: { label: string; done: boolean; hint: string }[] = [
    { label: "Environment", done: Boolean(s.environment), hint: `${s.environment ?? "sandbox"} selected` },
    { label: "Business short code", done: Boolean(s.short_code), hint: s.short_code ? "Saved" : "Not saved yet — enter it above and save" },
    { label: "Party B (store number)", done: Boolean(s.party_b ?? s.short_code), hint: s.party_b ? "Saved" : "Falls back to the short code" },
    { label: "Transaction type", done: Boolean(s.transaction_type), hint: s.transaction_type ?? "" },
    { label: "Consumer key", done: Boolean(s.has_consumer_key), hint: s.has_consumer_key ? "Stored" : "Paste it above and save" },
    { label: "Consumer secret", done: Boolean(s.has_consumer_secret), hint: s.has_consumer_secret ? "Stored" : "Paste it above and save" },
    { label: "Passkey", done: Boolean(s.has_passkey), hint: s.has_passkey ? "Stored" : "Paste it above and save" },
    {
      label: "Callback address",
      done: Boolean(s.callback_url),
      hint: !s.callback_url
        ? "Save the settings to generate it"
        : s.callback_source === "configured"
          ? "Using the address you entered"
          : "Using this site's own address — enter your published address for live payments",
    },
    { label: "Switched on for collections", done: Boolean(s.enabled), hint: s.enabled ? "On" : "Turn on once the details above are saved" },
  ];
  const outstanding = readiness.filter((r) => !r.done);
  const callbackIsTemporary = Boolean(s.callback_temporary);
  /** Four separate facts, never merged into one "connected" claim. */
  const stage: Record<string, { tone: "info" | "warning" | "success"; text: string }> = {
    "not-configured": { tone: "warning", text: "Not configured" },
    configured: { tone: "warning", text: "Configured — not yet tested" },
    tested: { tone: "info", text: `Tested on ${s.environment ?? "sandbox"}` },
    "production-ready": { tone: "success", text: "Live and ready" },
  };
  const stagePill = stage[s.status ?? "not-configured"] ?? stage["not-configured"]!;

  return (
    <div className="space-y-6">
      <PageHeader
        title="M-Pesa (Safaricom Daraja)"
        description="Collect checkout and settlement payments over M-Pesa. Credentials are stored write-only and every prompt is reconciled against Safaricom's own result."
      />

      <PaymentReadinessPanel title="Payment methods in this workspace" />

      <SectionCard
        title="Setup readiness"
        description={
          outstanding.length === 0
            ? "Everything NEØ needs is in place. Register the callback address below with Safaricom and send a test prompt."
            : `${outstanding.length} item${outstanding.length === 1 ? "" : "s"} still needed before a payment prompt can be sent.`
        }
      >
        <ul className="grid gap-2 sm:grid-cols-2">
          {readiness.map((r) => (
            <li key={r.label} className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 p-2.5 text-sm">
              <span className="min-w-0">
                <span className="block font-medium">{r.label}</span>
                <span className="block text-xs text-muted-foreground">{r.hint}</span>
              </span>
              <StatusPill tone={r.done ? "success" : "warning"}>{r.done ? "Ready" : "Needed"}</StatusPill>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusPill tone={stagePill.tone}>{stagePill.text}</StatusPill>
          {s.status === "tested" && s.environment === "production" && !s.production_ready ? (
            <span>
              Live collections stay off until a published callback address is saved here and registered with Safaricom.
            </span>
          ) : null}
        </div>
        {callbackIsTemporary ? (
          <p className="mt-3 text-xs text-muted-foreground">
            This address belongs to the temporary editor preview. Register the address from your published site with Safaricom so
            confirmations keep arriving.
          </p>
        ) : null}
      </SectionCard>


      <SectionCard title="Connection" description="Paybill or till details and Daraja API credentials.">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Environment</Label>
            <Select value={environment} onValueChange={setEnvironment}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sandbox">Sandbox</SelectItem>
                <SelectItem value="production">Production</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Transaction type</Label>
            <Select value={transactionType} onValueChange={setTransactionType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CustomerPayBillOnline">Paybill (CustomerPayBillOnline)</SelectItem>
                <SelectItem value="CustomerBuyGoodsOnline">Till (CustomerBuyGoodsOnline)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-shortcode">Business short code</Label>
            <Input id="mp-shortcode" value={shortCode} onChange={(e) => setShortCode(e.target.value)} placeholder="174379" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-partyb">Party B (store number)</Label>
            <Input id="mp-partyb" value={partyB} onChange={(e) => setPartyB(e.target.value)} placeholder="Same as short code unless a till" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-account">Default account reference</Label>
            <Input id="mp-account" value={accountReference} onChange={(e) => setAccountReference(e.target.value)} placeholder="Hotel name or account" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-base">Public callback base URL (optional)</Label>
            <Input id="mp-base" value={callbackBaseUrl} onChange={(e) => setCallbackBaseUrl(e.target.value)} placeholder="Leave blank to use this site's address" />
            <p className="text-xs text-muted-foreground">Only needed if Safaricom must call a different address than this site.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-key">Consumer key {s.has_consumer_key ? "(stored)" : ""}</Label>
            <Input id="mp-key" type="password" value={consumerKey} onChange={(e) => setConsumerKey(e.target.value)} placeholder={s.has_consumer_key ? "••••••••" : "Paste key"} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-secret">Consumer secret {s.has_consumer_secret ? "(stored)" : ""}</Label>
            <Input id="mp-secret" type="password" value={consumerSecret} onChange={(e) => setConsumerSecret(e.target.value)} placeholder={s.has_consumer_secret ? "••••••••" : "Paste secret"} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mp-passkey">Passkey {s.has_passkey ? "(stored)" : ""}</Label>
            <Input id="mp-passkey" type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} placeholder={s.has_passkey ? "••••••••" : "Paste passkey"} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">Enabled for collections</p>
              <p className="text-xs text-muted-foreground">Staff can only send prompts while this is on.</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3 text-xs">
          <p className="font-medium">Callback URL to register with Safaricom</p>
          <p className="mt-1 break-all font-mono">{s.callback_url ?? "Save the settings to generate the callback URL."}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!s.callback_url}
              onClick={() => {
                void navigator.clipboard.writeText(s.callback_url ?? "");
                toast.success("Callback URL copied");
              }}
            >
              <Copy className="mr-2 size-3.5" /> Copy
            </Button>
            <Button size="sm" variant="outline" onClick={() => saveMutation.mutate(true)} disabled={saveMutation.isPending}>
              Rotate callback token
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => saveMutation.mutate(false)} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            Save settings
          </Button>
          <Button variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
            {testMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <PlugZap className="mr-2 size-4" />}
            Test connection
          </Button>
          {s.last_check_status ? (
            <StatusPill tone={s.last_check_status === "ok" ? "success" : "destructive"}>
              Last check: {s.last_check_status}
            </StatusPill>
          ) : (
            <StatusPill tone="default">Not verified</StatusPill>
          )}
        </div>
        {s.last_check_detail ? <p className="mt-2 text-xs text-muted-foreground">{s.last_check_detail}</p> : null}
      </SectionCard>

      <SectionCard
        title="Recent collections"
        description="Every prompt sent from checkout or settlement, with its provider outcome."
        actions={
          <Button size="sm" variant="outline" onClick={() => void transactions.refetch()}>
            <RefreshCw className="mr-2 size-3.5" /> Refresh
          </Button>
        }
      >
        {transactions.isLoading ? (
          <LoadingState variant="table" rows={4} />
        ) : (transactions.data ?? []).length === 0 ? (
          <EmptyState
            inline
            title="No M-Pesa prompts yet"
            description="Prompts appear here as soon as a payment request is sent from the till or folio."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2">When</th>
                  <th>Phone</th>
                  <th>Amount</th>
                  <th>For</th>
                  <th>Receipt</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(transactions.data ?? []).map((t) => (
                  <tr key={t.id as string} className="border-t border-border">
                    <td className="py-2">{new Date(t.created_at as string).toLocaleString()}</td>
                    <td>{t.msisdn as string}</td>
                    <td>{Number(t.amount).toFixed(2)}</td>
                    <td>{t.source_module === "folio" ? "Guest folio" : "Restaurant bill"} {t.account_reference ?? ""}</td>
                    <td>{(t.mpesa_receipt_number as string) ?? "—"}</td>
                    <td>
                      <StatusPill tone={STATUS_TONE[t.status as string] ?? "default"}>{t.status as string}</StatusPill>
                    </td>
                    <td className="text-right">
                      {t.applied_at ? null : (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={reconcileMutation.isPending}
                          onClick={() => reconcileMutation.mutate(t.id as string)}
                        >
                          Reconcile
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Callbacks that could not be applied"
        description="A provider confirmation NEØ received but could not post. Each entry shows exactly what happened and can be re-applied safely — a payment already posted is never posted twice."
        actions={
          <Button size="sm" variant="outline" onClick={() => void failedCallbacks.refetch()}>
            <RefreshCw className="mr-2 size-3.5" /> Refresh
          </Button>
        }
      >
        {failedCallbacks.isLoading ? (
          <LoadingState variant="table" rows={2} />
        ) : (failedCallbacks.data ?? []).length === 0 ? (
          <EmptyState
            inline
            title="Nothing awaiting re-apply"
            description="Every confirmation the provider sent has been applied to its transaction."
          />
        ) : (
          <div className="space-y-2">
            {(failedCallbacks.data ?? []).map((e) => (
              <div
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/40 p-3"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <StatusPill tone="destructive">Not applied</StatusPill>
                    {new Date(e.received_at).toLocaleString()}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">{e.detail ?? "No detail recorded."}</p>
                  <p className="text-xs text-muted-foreground">Reference {e.checkout_request_id ?? "—"}</p>
                </div>
                <Button
                  size="sm"
                  disabled={retryCallback.isPending}
                  onClick={() => retryCallback.mutate(e.id)}
                >
                  Re-apply safely
                </Button>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

