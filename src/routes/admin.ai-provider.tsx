/**
 * Administration → AI Provider.
 *
 * Configure which AI provider NEØ Intelligence uses, store its key (write-only)
 * and prove connectivity with a live test before any runtime call depends on it.
 */
import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, PlugZap, Save, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  getAiProviderSettings,
  saveAiProviderSettings,
  testAiProvider,
  type AiProviderSettings,
} from "@/lib/ai-provider.functions";

export const Route = createFileRoute("/admin/ai-provider")({
  head: () => ({
    meta: [
      { title: "AI Provider — NEØ Administration" },
      {
        name: "description",
        content:
          "Choose the AI provider and model NEØ Intelligence uses, store the provider key securely and validate connectivity before runtime calls.",
      },
      { property: "og:title", content: "AI Provider — NEØ Administration" },
      { property: "og:description", content: "Configure and test the workspace AI provider for NEØ Intelligence." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AiProviderPage,
});

const PROVIDERS = [
  { value: "lovable", label: "Built-in NEØ AI gateway", hint: "Managed by the platform. No key required unless you supply your own." },
  { value: "openai", label: "OpenAI", hint: "Uses https://api.openai.com/v1 with your own key." },
  { value: "custom", label: "Custom OpenAI-compatible endpoint", hint: "Any provider exposing /chat/completions." },
];

const MODEL_HINT: Record<string, string> = {
  lovable: "google/gemini-3-flash-preview",
  openai: "gpt-5-mini",
  custom: "provider-specific model id",
};

function AiProviderPage() {
  const load = useServerFn(getAiProviderSettings);
  const save = useServerFn(saveAiProviderSettings);
  const test = useServerFn(testAiProvider);
  const queryClient = useQueryClient();

  const settings = useQuery<AiProviderSettings>({
    queryKey: ["ai-provider-settings"],
    queryFn: () => load({ data: undefined as never }),
  });

  const [provider, setProvider] = useState("lovable");
  const [model, setModel] = useState("google/gemini-3-flash-preview");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);

  const data = settings.data;

  useEffect(() => {
    if (!data?.authorised) return;
    setProvider(data.provider ?? "lovable");
    setModel(data.model ?? "google/gemini-3-flash-preview");
    setBaseUrl(data.base_url ?? "");
    setEnabled(data.enabled !== false);
    setApiKey("");
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (clearKey: boolean) =>
      save({
        data: {
          provider,
          model,
          baseUrl: baseUrl || null,
          apiKey: apiKey || null,
          enabled,
          clearKey,
        },
      }),
    onSuccess: (result) => {
      if (!result.authorised) {
        toast.error(result.reason ?? "Not permitted");
        return;
      }
      if (!result.saved) {
        toast.error(result.reason ?? "Nothing was saved");
        return;
      }
      setApiKey("");
      toast.success("AI provider settings saved");
      void queryClient.invalidateQueries({ queryKey: ["ai-provider-settings"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save"),
  });

  const testMutation = useMutation({
    mutationFn: () => test({ data: undefined as never }),
    onSuccess: (result) => {
      if (!result.authorised) {
        toast.error(result.detail ?? "Not permitted");
        return;
      }
      if (result.ok) toast.success(`${result.provider} responded in ${result.duration_ms} ms`);
      else toast.error(result.detail ?? "The provider did not respond");
      void queryClient.invalidateQueries({ queryKey: ["ai-provider-settings"] });
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Connectivity test failed"),
  });

  if (settings.isLoading) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">Loading AI provider settings…</p>
    );
  }

  if (data && !data.authorised) {
    return (
      <AccessDeniedPanel
        subject="AI provider settings"
        detail={data.reason ?? "You do not have permission to configure the AI provider."}
      />
    );
  }

  const lastStatus = data?.last_check_status ?? null;
  const tone = lastStatus === "ok" ? "success" : lastStatus ? "destructive" : "default";

  return (
    <div>
      <PageHeader
        eyebrow="System"
        title="AI Provider"
        description="NEØ Intelligence only ever sends already-authorised figures to the provider chosen here. The key is stored server-side and is never returned to the browser."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Provider" description="Switch provider, endpoint and model.">
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="provider">Provider</Label>
              <Select
                value={provider}
                onValueChange={(v) => {
                  setProvider(v);
                  if (MODEL_HINT[v] && !model) setModel(MODEL_HINT[v]);
                }}
              >
                <SelectTrigger id="provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {PROVIDERS.find((p) => p.value === provider)?.hint}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="model">Model</Label>
              <Input
                id="model"
                value={model}
                placeholder={MODEL_HINT[provider]}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>

            {provider !== "lovable" ? (
              <div className="grid gap-1.5">
                <Label htmlFor="base">Endpoint base URL</Label>
                <Input
                  id="base"
                  value={baseUrl}
                  placeholder={provider === "openai" ? "https://api.openai.com/v1" : "https://your-provider/v1"}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Must expose an OpenAI-compatible /chat/completions route.</p>
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="enabled">AI generation enabled</Label>
              <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>
        </SectionCard>

        <SectionCard title="API key" description="Write-only. Saving a new value replaces the stored key.">
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={data?.has_key ? "success" : "warning"}>
                {data?.has_key ? "Workspace key stored" : "No workspace key"}
              </StatusPill>
              {data?.platform_key_available ? (
                <StatusPill tone="info">Platform gateway key available as fallback</StatusPill>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="key">New API key</Label>
              <Input
                id="key"
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={data?.has_key ? "•••••••• (leave blank to keep current key)" : "Paste the provider key"}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => saveMutation.mutate(false)} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                Save settings
              </Button>
              <Button
                variant="outline"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
              >
                {testMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                Test connectivity
              </Button>
              {data?.has_key ? (
                <Button variant="ghost" onClick={() => saveMutation.mutate(true)} disabled={saveMutation.isPending}>
                  Remove stored key
                </Button>
              ) : null}
            </div>
          </div>
        </SectionCard>
      </div>

      <SectionCard
        className="mt-6"
        title="Last connectivity check"
        description="A real request is made to the provider. Nothing here is simulated."
      >
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          <StatusPill tone={tone}>
            {lastStatus === "ok" ? "Connectivity verified" : lastStatus ? `Failed: ${lastStatus}` : "Never tested"}
          </StatusPill>
          <span className="text-muted-foreground">
            {data?.last_check_at ? new Date(data.last_check_at).toLocaleString() : "No check has been run for this workspace."}
          </span>
        </div>
        {data?.last_check_detail ? (
          <p className="mt-2 text-xs text-muted-foreground">{data.last_check_detail}</p>
        ) : null}
      </SectionCard>
    </div>
  );
}
