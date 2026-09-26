/**
 * Shared presentation pieces for the Phase 17 platform readiness screens.
 * Status is always rendered from stored evidence — nothing here implies a
 * provider is live unless the record says every verification step passed.
 */
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from "lucide-react";
import { StatusPill } from "@/components/common/DataDisplay";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { StateCard } from "@/components/common/StateSystem";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const PILL_TONE: Record<Tone, "default" | "success" | "warning" | "info" | "destructive"> = {
  neutral: "default",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "destructive",
};

export function TonePill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <StatusPill tone={PILL_TONE[tone]}>{children}</StatusPill>;
}

export function statusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (["passed", "connected", "active", "closed", "resolved", "verified", "published", "completed"].includes(s)) return "success";
  if (["failed", "critical", "suspended", "blocked", "expired", "dead_letter", "cancelled"].includes(s)) return "danger";
  if (["degraded", "in_progress", "grace_period", "pending", "waived", "retrying", "trial", "investigating"].includes(s)) return "warning";
  if (["configured", "sandbox_tested", "dry_run", "approved", "new", "open", "planned"].includes(s)) return "info";
  return "neutral";
}

export function humanise(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function EvidenceRow({ label, met }: { label: string; met: boolean }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {met ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
      ) : (
        <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <span className={cn(met ? "text-foreground" : "text-muted-foreground")}>{label}</span>
    </li>
  );
}

export function TruthNotice({ children }: { children: ReactNode }) {
  return (
    <Card className="border-info/40 bg-info/5">
      <CardContent className="flex items-start gap-3 py-4">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-info" />
        <p className="text-sm text-muted-foreground">{children}</p>
      </CardContent>
    </Card>
  );
}

export function AccessDenied({ title, body }: { title: string; body: string }) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="flex items-start gap-3 py-6">
        <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{body}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return <StateCard variant="empty" title={title} description={body} />;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
