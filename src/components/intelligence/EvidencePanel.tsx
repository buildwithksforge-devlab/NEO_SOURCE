/**
 * Evidence disclosure: what records a statement came from, how many, and the
 * route into the module where a human can inspect them.
 *
 * The default reading is elegant — the business sources, a coverage word and
 * the time it was computed. Row counts, table names and model detail stay one
 * click away behind "View evidence".
 */
import { Link } from "@tanstack/react-router";
import { ChevronDown, ExternalLink } from "lucide-react";
import { MODULE_LABEL, STATEMENT_LABEL, type Confidence, type Evidence, type Scope, type Statement } from "@/lib/intelligence-types";

const COVERAGE_WORD: Record<Confidence, string> = {
  high: "High",
  moderate: "Moderate",
  insufficient: "Incomplete",
};

/**
 * The premium reading of provenance: which business sources, how complete the
 * coverage is, when it was computed — with the technical detail on demand.
 */
export function EvidenceSummary({
  evidence,
  confidence,
  scope,
  children,
}: {
  evidence: Evidence[];
  confidence: Confidence;
  scope?: Scope;
  children?: React.ReactNode;
}) {
  const sources = Array.from(new Set(evidence.map((e) => MODULE_LABEL[e.module])));
  const updated = scope?.freshness ? new Date(scope.freshness) : null;
  return (
    <details data-testid="evidence-summary" className="neo-evidence group rounded-2xl border border-outline-subtle bg-card/60">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0 text-sm">
          <p className="text-muted-foreground">
            Based on:{" "}
            <span className="font-medium text-foreground">
              {sources.length ? sources.join(" · ") : "no recorded source"}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Coverage: {COVERAGE_WORD[confidence]}
            {updated ? ` · Updated: ${updated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
          View evidence
          <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
        </span>
      </summary>
      <div className="space-y-3 border-t border-outline-subtle p-3">
        <EvidenceList evidence={evidence} />
        {children}
      </div>
    </details>
  );
}


export function StatementLine({ statement }: { statement: Statement }) {
  const tone =
    statement.kind === "limitation"
      ? "bg-tint-warning text-on-tint-warning"
      : statement.kind === "recommendation"
        ? "bg-tint-accent text-on-tint-accent"
        : statement.kind === "forecast"
          ? "bg-tint-info text-on-tint-info"
          : "bg-chip text-chip-foreground";
  return (
    <li className="flex min-w-0 items-start gap-2 py-1.5">
      <span className={`mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[0.62rem] font-semibold uppercase tracking-wide ${tone}`}>
        {STATEMENT_LABEL[statement.kind]}
      </span>
      <span className="min-w-0 text-sm leading-snug">{statement.text}</span>
    </li>
  );
}

export function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="divide-y divide-outline-subtle rounded-xl border border-outline-subtle bg-card/60">
      {evidence.map((e, i) => (
        <li key={`${e.label}-${i}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{e.label}</p>
            <p className="truncate text-xs text-muted-foreground">
              {MODULE_LABEL[e.module]} · {e.source}
              {e.recordCount !== null && e.recordCount !== undefined ? ` · ${e.recordCount} record(s)` : ""}
            </p>
          </div>
          {e.drillTo ? (
            <Link
              to={e.drillTo}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-outline-subtle px-2.5 py-1.5 text-xs font-medium hover:bg-muted/60"
            >
              See records <ExternalLink className="size-3" />
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function ScopeLine({ scope, confidence }: { scope: Scope; confidence: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {scope.propertyLabel} · {scope.from} → {scope.to}
      {scope.freshness ? ` · computed ${new Date(scope.freshness).toLocaleTimeString()}` : ""} · {confidence} confidence
    </p>
  );
}
