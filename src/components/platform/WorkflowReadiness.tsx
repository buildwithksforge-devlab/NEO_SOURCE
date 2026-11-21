import { Link } from "@tanstack/react-router";
import { SectionCard } from "@/components/common/DataDisplay";
import { TonePill, formatDateTime } from "@/components/platform/PlatformShared";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useGoLiveReadiness, readinessLabels, type ReadinessCheck } from "@/lib/go-live";
import { canAccessPath } from "@/lib/nav-permissions";

export function WorkflowReadiness() {
  const { branchId } = useActivePropertyFilter();
  if (!branchId) return <SectionCard title="Property workflow evidence"><p className="text-sm text-muted-foreground">Select a property to see its configuration progress and blockers.</p></SectionCard>;
  return <PropertyWorkflowReadiness />;
}

function PropertyWorkflowReadiness() {
  const { can } = useAuth();
  const readiness = useGoLiveReadiness();
  const checks = readiness.isSuccess ? readiness.data.checks : [];
  const groups = new Map<string, ReadinessCheck[]>();
  for (const check of checks) {
    const current = groups.get(check.domain) ?? [];
    current.push(check);
    groups.set(check.domain, current);
  }
  const ready = checks.filter((check) => check.status === "ready").length;
  const blocked = checks.filter((check) => check.status === "blocked").length;
  const percent = checks.length ? Math.floor(100 * ready / checks.length) : 0;
  return (
    <SectionCard title="Property workflow evidence" description="Live configuration and saved records for the selected property. Use Simulation Centre to review end-to-end test evidence."
      actions={<Button size="sm" variant="outline" onClick={() => void readiness.refetch()} disabled={readiness.isFetching}>Recheck configuration</Button>}>
      {readiness.isError ? <p className="text-sm text-destructive" role="alert">NEØ couldn’t verify this property’s configuration. Recheck to retry.</p>
        : readiness.isPending ? <p className="text-sm text-muted-foreground" role="status">Reading property configuration…</p>
        : checks.length === 0 ? <p className="text-sm text-muted-foreground">No workflow configuration evidence was returned for this property.</p>
        : <div className="space-y-4">
          <div>
            <p className="mb-2 text-sm font-medium">{percent}% configuration verified · {ready} of {checks.length} checks ready</p>
            <Progress value={percent} aria-label="Percentage of configuration checks verified" />
            <p className="mt-2 text-xs text-muted-foreground">{blocked} blocked · {checks.length - ready - blocked} awaiting attention or verification · {formatDateTime(readiness.data?.generated_at)}</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {[...groups.entries()].map(([domain, entries]) => (
              <section key={domain} className="rounded-lg border p-3">
                <h3 className="font-semibold">{domain}</h3>
                <ul className="mt-2 divide-y">
                  {entries.map((check) => (
                    <li key={check.key} className="space-y-1 py-2 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>{check.label}</span>
                        <TonePill tone={check.status === "ready" ? "success" : check.status === "blocked" ? "danger" : "warning"}>{readinessLabels[check.status]}</TonePill>
                      </div>
                      <p className="text-muted-foreground">{check.detail}</p>
                      {check.status !== "ready" && check.route.startsWith("/") && !check.route.startsWith("//") && canAccessPath(can, check.route) ?
                        <Link to={check.route} className="inline-block text-xs font-medium underline">Open affected workflow</Link> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>}
    </SectionCard>
  );
}
