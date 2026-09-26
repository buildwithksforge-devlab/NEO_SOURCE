/**
 * Discovery and decision presentation. Both are advisory: NEØ prepares the
 * case and the evidence, an authorised human takes the action in the module.
 */
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/common/DataDisplay";
import { EvidenceList, EvidenceSummary } from "@/components/intelligence/EvidencePanel";
import { MODULE_LABEL, type Decision, type Discovery, type Severity } from "@/lib/intelligence-types";

const toneFor = (s: Severity) => (s === "critical" ? "destructive" : s === "warning" ? "warning" : "info");

export function DiscoveryCard({
  discovery,
  onInvestigate,
}: {
  discovery: Discovery;
  onInvestigate?: (topic: string) => void;
}) {
  return (
    <article
      data-testid="discovery-card"
      data-severity={discovery.severity}
      className={
        "neo-discovery flex min-w-0 flex-col gap-3 rounded-2xl border border-outline-subtle border-l-[3px] p-4 " +
        (discovery.severity === "critical"
          ? "border-l-destructive"
          : discovery.severity === "warning"
            ? "border-l-warning"
            : "border-l-primary/50")
      }
    >
      <header className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="min-w-0 text-sm font-semibold">{discovery.title}</h4>
          <StatusPill tone={toneFor(discovery.severity)}>{discovery.severity}</StatusPill>
          {discovery.outlier ? <StatusPill tone="accent">Outlier</StatusPill> : null}
          {discovery.confidence ? (
            <StatusPill
              tone={
                discovery.confidence === "high"
                  ? "success"
                  : discovery.confidence === "moderate"
                    ? "info"
                    : "warning"
              }
            >
              {discovery.confidence} confidence
            </StatusPill>
          ) : null}
        </div>
        <p className="mt-1 text-sm leading-snug text-muted-foreground">{discovery.conclusion}</p>
      </header>

      <p className="text-xs text-muted-foreground">
        {discovery.impact
          ? `Recorded value: ${discovery.impact.currency} ${new Intl.NumberFormat("en-KE", { maximumFractionDigits: 0 }).format(discovery.impact.value)}. `
          : ""}
        {discovery.impactNote} · {discovery.modules.map((m) => MODULE_LABEL[m]).join(" · ")}
      </p>

      {discovery.confidence ? (
        <EvidenceSummary evidence={discovery.evidence} confidence={discovery.confidence}>
          <p className="text-xs text-muted-foreground">{discovery.confidenceNote}</p>
        </EvidenceSummary>
      ) : (
        <EvidenceList evidence={discovery.evidence} />
      )}


      <div data-action-cluster className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        {discovery.investigate && onInvestigate ? (
          <Button size="sm" variant="secondary" onClick={() => onInvestigate(discovery.investigate as string)}>
            <ScanSearch className="size-4" /> Investigate
          </Button>
        ) : null}
        {discovery.drillTo ? (
          <Button asChild size="sm" variant="outline">
            <Link to={discovery.drillTo}>
              See records <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function DecisionCard({ decision }: { decision: Decision }) {
  return (
    <article data-testid="decision-card" className="neo-decision space-y-3 rounded-2xl border border-outline-subtle p-4">
      <header className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="min-w-0 text-sm font-semibold">{decision.headline}</h4>
          <StatusPill tone={decision.kind === "recommendation" ? "accent" : "info"}>
            {decision.kind === "recommendation" ? "Recommendation" : "Observation"}
          </StatusPill>
          <StatusPill tone={decision.confidence === "high" ? "success" : decision.confidence === "moderate" ? "info" : "warning"}>
            {decision.confidence} confidence
          </StatusPill>
        </div>
        <p className="mt-1 text-sm leading-snug text-muted-foreground">{decision.why}</p>
      </header>

      <p className="text-xs text-muted-foreground">{decision.confidenceNote}</p>
      <p className="text-sm">{decision.impact}</p>

      {decision.scenario ? (
        <div className="rounded-xl border border-outline-subtle bg-card/60 p-3">
          <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">
            {decision.scenario.label}
          </p>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            {[...decision.scenario.inputs, ...decision.scenario.outputs].map((row) => (
              <div key={row.label} className="min-w-0">
                <dt className="truncate text-xs text-muted-foreground">{row.label}</dt>
                <dd className="truncate text-sm font-medium tabular-nums">{row.value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">{decision.scenario.method}</p>
        </div>
      ) : null}

      <div>
        <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted-foreground">Alternatives</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {decision.alternatives.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>

      <EvidenceList evidence={decision.evidence} />

      <div data-action-cluster className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <p className="text-xs text-muted-foreground">
          NEØ never applies this. An authorised user acts in the module.
        </p>
        {decision.action ? (
          <Button asChild size="sm" variant="outline">
            <Link to={decision.action.to}>{decision.action.label}</Link>
          </Button>
        ) : null}
      </div>
    </article>
  );
}
