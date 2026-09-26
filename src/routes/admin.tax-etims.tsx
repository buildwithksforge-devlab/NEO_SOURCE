/**
 * Administration → KRA eTIMS.
 *
 * Holds the tenant's fiscal device credentials write-only, proves the device is
 * recognised by KRA before any invoice depends on it, and shows the filing
 * status of every document submitted from Finance.
 */
import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, PlugZap, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { FileWithKraButton } from "@/components/finance/FileWithKraButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { getEtimsSettings, saveEtimsSettings, testEtimsConnection, type EtimsSettings } from "@/lib/etims.functions";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export const Route = createFileRoute("/admin/tax-etims")({
  head: () => ({
    meta: [
      { title: "KRA eTIMS — NEØ Administration" },
      {
        name: "description",
        content:
          "Connect NEØ to KRA eTIMS: store fiscal device credentials securely, verify the device and track the filing status of every invoice and credit note.",
      },
      { property: "og:title", content: "KRA eTIMS — NEØ Administration" },
      { property: "og:description", content: "Configure KRA eTIMS filing and monitor fiscal submissions." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: EtimsAdminPage,
});

const STATUS_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  accepted: "success",
  submitted: "warning",
  queued: "warning",
  pending: "warning",
  retry_required: "warning",
  rejected: "destructive",
  failed: "destructive",
};

function EtimsAdminPage() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const load = useServerFn(getEtimsSettings);
  const save = useServerFn(saveEtimsSettings);
  const test = useServerFn(testEtimsConnection);
  const queryClient = useQueryClient();

  const settings = useQuery<EtimsSettings>({
    queryKey: ["etims-settings", filterKey],
    queryFn: () => load({ data: undefined as never }),
  });

  const [environment, setEnvironment] = useState("sandbox");
  const [mode, setMode] = useState("oscu");
  const [baseUrl, setBaseUrl] = useState("");
  const [kraPin, setKraPin] = useState("");
  const [branchCode, setBranchCode] = useState("00");
  const [deviceSerial, setDeviceSerial] = useState("");
  const [cmcKey, setCmcKey] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(true);

  useEffect(() => {
    const s = settings.data;
    if (!s?.authorised) return;
    setEnvironment(s.environment ?? "sandbox");
    setMode(s.mode ?? "oscu");
    setBaseUrl(s.base_url ?? "");
    setKraPin(s.kra_pin ?? "");
    setBranchCode(s.branch_code ?? "00");
    setDeviceSerial(s.device_serial ?? "");
    setEnabled(Boolean(s.enabled));
    setAutoSubmit(s.auto_submit !== false);
  }, [settings.data]);

  const submissions = useQuery({
    queryKey: ["etims-submissions-admin", filterKey],
    enabled: Boolean(settings.data?.authorised),
    refetchInterval: 20000,
    queryFn: async () => {
      const { data, error } = await applyTo(supabase.from("etims_submissions").select("id, created_at, document_kind, document_number, status, kra_reference, attempts, last_attempt_at, error_details, invoice_id, credit_note_id"), "etims_submissions")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data ?? [];
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (clearSecrets: boolean) =>
      save({
        data: {
          environment,
          mode,
          baseUrl,
          kraPin,
          branchCode,
          deviceSerial,
          cmcKey: cmcKey || null,
          apiKey: apiKey || null,
          enabled,
          autoSubmit,
          clearSecrets,
        },
      }),
    onSuccess: (result) => {
      if (!result.authorised) return void toast.error(result.reason ?? "Not permitted.");
      if (!result.saved) return void toast.error(result.reason ?? "Nothing was saved.");
      setCmcKey("");
      setApiKey("");
      toast.success("eTIMS settings saved");
      void queryClient.invalidateQueries({ queryKey: ["etims-settings", filterKey] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const testMutation = useMutation({
    mutationFn: async () => test({ data: undefined as never }),
    onSuccess: (result) => {
      if (result.ok) toast.success(result.detail);
      else toast.error(result.detail);
      void queryClient.invalidateQueries({ queryKey: ["etims-settings", filterKey] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  if (settings.isLoading) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading eTIMS settings…
      </div>
    );
  }

  if (!settings.data?.authorised) {
    return (
      <AccessDeniedPanel
        subject="KRA eTIMS settings"
        detail={settings.data?.reason ?? "You do not have permission to configure eTIMS."}
      />
    );
  }

  const s = settings.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="KRA eTIMS"
        description="File tax invoices and credit notes with KRA. Device keys are stored write-only and a document is only marked fiscalised once KRA itself accepts it."
      />

      <SectionCard title="Fiscal device" description="Trader details and the control unit credentials issued by KRA.">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Environment</Label>
            <Select value={environment} onValueChange={setEnvironment}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sandbox">Sandbox (test)</SelectItem>
                <SelectItem value="production">Production (live filing)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Device mode</Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="oscu">OSCU (online control unit)</SelectItem>
                <SelectItem value="vscu">VSCU (virtual control unit)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="et-url">eTIMS service URL</Label>
            <Input id="et-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://etims-api-sbx.kra.go.ke/etims-api" />
            <p className="text-xs text-muted-foreground">The base URL KRA gave you for this device, without a trailing slash.</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="et-pin">KRA PIN</Label>
            <Input id="et-pin" value={kraPin} onChange={(e) => setKraPin(e.target.value.toUpperCase())} placeholder="P051234567X" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="et-branch">Branch code</Label>
            <Input id="et-branch" value={branchCode} onChange={(e) => setBranchCode(e.target.value)} placeholder="00" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="et-serial">Device serial number</Label>
            <Input id="et-serial" value={deviceSerial} onChange={(e) => setDeviceSerial(e.target.value)} placeholder="Serial registered with KRA" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="et-cmc">CMC key {s.has_cmc_key ? "(stored)" : ""}</Label>
            <Input id="et-cmc" type="password" value={cmcKey} onChange={(e) => setCmcKey(e.target.value)} placeholder={s.has_cmc_key ? "••••••••" : "Paste communication key"} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="et-api">API key / bearer token {s.has_api_key ? "(stored)" : ""}</Label>
            <Input id="et-api" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={s.has_api_key ? "••••••••" : "Only if your integrator issued one"} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">Enabled for filing</p>
              <p className="text-xs text-muted-foreground">Documents can only be filed while this is on.</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">File automatically on issue</p>
              <p className="text-xs text-muted-foreground">Otherwise finance files each document manually.</p>
            </div>
            <Switch checked={autoSubmit} onCheckedChange={setAutoSubmit} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => saveMutation.mutate(false)} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Save className="mr-2 size-4" />}
            Save settings
          </Button>
          <Button variant="outline" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
            {testMutation.isPending ? <Loader2 className="mr-2 size-4 animate-spin" /> : <PlugZap className="mr-2 size-4" />}
            Test device
          </Button>
          <Button variant="ghost" onClick={() => saveMutation.mutate(true)} disabled={saveMutation.isPending}>
            Clear stored keys
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
        title="Recent submissions"
        description="Filing status straight from KRA, with the fiscal reference and any rejection reason."
        actions={
          <Button size="sm" variant="outline" onClick={() => void submissions.refetch()}>
            <RefreshCw className="mr-2 size-3.5" /> Refresh
          </Button>
        }
      >
        {submissions.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading submissions…</p>
        ) : (submissions.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No documents have been filed yet. Issue a tax invoice in Finance, then file it from there or here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Document</th>
                  <th className="py-2 pr-4">Kind</th>
                  <th className="py-2 pr-4">KRA reference</th>
                  <th className="py-2 pr-4">Attempts</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(submissions.data ?? []).map((row) => (
                  <tr key={String(row.id)}>
                    <td className="py-2 pr-4 font-mono text-xs">{String(row.document_number ?? "—")}</td>
                    <td className="py-2 pr-4">{String(row.document_kind).replace("_", " ")}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{String(row.kra_reference ?? "—")}</td>
                    <td className="py-2 pr-4">{Number(row.attempts ?? 0)}</td>
                    <td className="py-2 pr-4">
                      <StatusPill tone={STATUS_TONE[String(row.status)] ?? "default"}>{String(row.status)}</StatusPill>
                      {row.error_details ? (
                        <p className="mt-1 max-w-sm text-xs text-muted-foreground">{String(row.error_details)}</p>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4">
                      {String(row.status) === "accepted" ? (
                        <span className="text-xs text-muted-foreground">Filed</span>
                      ) : (
                        <FileWithKraButton
                          invoiceId={row.invoice_id ? String(row.invoice_id) : null}
                          creditNoteId={row.credit_note_id ? String(row.credit_note_id) : null}
                          label="Retry"
                          disabled={!s.enabled}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
