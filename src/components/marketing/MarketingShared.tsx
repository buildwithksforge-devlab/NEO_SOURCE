import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { AlertTriangle, Info, PlugZap, Sparkles } from "lucide-react";
import { StatusPill } from "@/components/common/DataDisplay";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { providerStatusLabels, providerTone, type ProviderStatus } from "@/lib/marketing";

/**
 * Shown wherever a channel or integration has no valid provider configuration.
 * Nothing is faked behind it — the surrounding feature stays read-only.
 */
export function NotConfigured({ channel, detail }: { channel: string; detail?: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex items-start gap-3 py-5">
        <span className="rounded-lg bg-warning/20 p-2 text-on-tint-warning">
          <PlugZap className="size-4" />
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">{channel} — Not Configured</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {detail ??
              "Add a verified provider in Marketing Settings before anything can be sent or imported. No messages are queued and no results are estimated while this is unconfigured."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function ProviderBadge({ label, status }: { label: string; status: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <StatusPill tone={providerTone(status)}>
        {providerStatusLabels[status as ProviderStatus] ?? "Not Configured"}
      </StatusPill>
    </div>
  );
}

export { EmptyState } from "@/components/common/StateSystem";

/** Advisory-only AI panel. It never acts; a human must decide and execute. */
export function AdvisoryPanel({
  configured,
  insights,
}: {
  configured: boolean;
  insights: { title: string; body: string }[];
}) {
  if (!configured) {
    return <NotConfigured channel="AI Marketing Assistant" detail="Connect an AI provider in Marketing Settings to receive advisory suggestions. Recommendations are never executed automatically." />;
  }
  return (
    <div className="space-y-3">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        <Sparkles className="size-3.5" /> Advisory only — requires human review
      </p>
      {insights.map((i) => (
        <Card key={i.title} className="surface-panel">
          <CardContent className="py-4">
            <p className="text-sm font-semibold text-foreground">{i.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{i.body}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Compliance reminder used above anything that can contact a customer. */
export function ConsentNotice({ children }: { children?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm text-on-tint-warning">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <p>
        {children ??
          "Marketing messages are only queued for customers with recorded consent on that channel who are not suppressed. Service messages such as booking confirmations are handled separately and are not affected by marketing consent."}
      </p>
    </div>
  );
}

export function MetricTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "success" | "warning" | "destructive";
}) {
  const toneClass = {
    default: "text-foreground",
    success: "text-success",
    warning: "text-on-tint-warning",
    destructive: "text-destructive",
  }[tone ?? "default"];
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tracking-tight", toneClass)}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Marketing users see contact details masked unless they hold the permission. */
export function maskContact(value: string | null | undefined, reveal: boolean): string {
  if (!value) return "—";
  if (reveal) return value;
  if (value.includes("@")) {
    const [name = "", domain = ""] = value.split("@");
    return `${name.slice(0, 2)}•••@${domain}`;
  }
  return `${value.slice(0, 3)}•••${value.slice(-2)}`;
}
