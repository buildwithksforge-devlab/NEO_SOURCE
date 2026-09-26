/**
 * Investigate mode: one issue, broken into contributing groups with the
 * records behind each. Anything the payload cannot explain is stated as a
 * limitation rather than filled in.
 */
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EvidenceList, ScopeLine, StatementLine } from "@/components/intelligence/EvidencePanel";
import { NeoBrain } from "@/components/intelligence/NeoBrain";
import type { Investigation } from "@/lib/intelligence-types";

export function InvestigationPane({
  investigation,
  onClose,
}: {
  investigation: Investigation;
  onClose: () => void;
}) {
  return (
    <section data-testid="investigation-pane" className="neo-investigation space-y-4 rounded-2xl border border-outline-subtle p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-primary">Investigation</p>
          <h3 className="text-base font-semibold">{investigation.title}</h3>
          <p className="text-sm text-muted-foreground">{investigation.summary}</p>
          <ScopeLine scope={investigation.scope} confidence="grounded" />
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close investigation">
          <X className="size-4" />
        </Button>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0 space-y-3">
          <ul className="grid gap-2 sm:grid-cols-2">
            {investigation.groups.map((g) => (
              <li key={g.label} className="min-w-0 rounded-xl border border-outline-subtle bg-card/60 p-3">
                <p className="truncate text-xs uppercase tracking-wide text-muted-foreground">{g.label}</p>
                <p className="mt-0.5 text-xl font-semibold tabular-nums">{g.value ?? "—"}</p>
                <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{g.note}</p>
                {g.drillTo ? (
                  <Link to={g.drillTo} className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
                    See records
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>

          <ul className="divide-y divide-outline-subtle">
            {investigation.drivers.map((d, i) => (
              <StatementLine key={i} statement={d} />
            ))}
          </ul>

          <EvidenceList evidence={investigation.evidence} />

          <div data-action-cluster className="flex flex-wrap gap-2">
            {investigation.actions.map((a) => (
              <Button key={a.to} asChild size="sm" variant="outline">
                <Link to={a.to}>{a.label}</Link>
              </Button>
            ))}
          </div>
        </div>

        <NeoBrain active={investigation.modules} caption="Modules examined for this investigation." />
      </div>
    </section>
  );
}
