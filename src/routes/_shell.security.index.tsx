import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertTriangle, PackageSearch, ShieldCheck, Users } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  EmptyState,
  QueryState,
  SecurityGuard,
  SecurityStatusBadge,
  SeverityBadge,
} from "@/components/security/SecurityShared";
import { Button } from "@/components/ui/button";
import { titleCase } from "@/lib/kitchen";
import {
  patrolProgress,
  securityStr,
  useSecurityAssignments,
  useSecurityIncidents,
  useSecurityPatrols,
  useSecurityStockNeeds,
  type SecurityRow,
} from "@/lib/security-department";

export const Route = createFileRoute("/_shell/security/")({
  head: () => ({
    meta: [
      { title: "Security Department — NEØ" },
      {
        name: "description",
        content:
          "Security operations at a glance: open incidents, guards on post, patrol completion and departmental supplies awaiting a requisition.",
      },
      { property: "og:title", content: "Security Department — NEØ" },
      {
        property: "og:description",
        content: "Incidents, posts, patrols and guard coverage in one Security view.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <SecurityGuard feature="overview">
      <SecurityHome />
    </SecurityGuard>
  ),
});

function SecurityHome() {
  const incidents = useSecurityIncidents();
  const patrols = useSecurityPatrols();
  const assignments = useSecurityAssignments(new Date().toISOString().slice(0, 10));
  const needs = useSecurityStockNeeds();

  const incidentRows = (incidents.data ?? []) as SecurityRow[];
  const openIncidents = incidentRows.filter(
    (r) => !["closed", "resolved"].includes(String(r["status"])),
  );
  const escalated = incidentRows.filter((r) => String(r["status"]) === "escalated");
  const patrolRows = (patrols.data ?? []) as SecurityRow[];
  const openPatrols = patrolRows.filter(
    (r) => !["completed", "cancelled"].includes(String(r["status"])),
  );
  const onPost = ((assignments.data ?? []) as SecurityRow[]).filter(
    (r) => String(r["status"]) === "assigned",
  );
  const openNeeds = ((needs.data ?? []) as SecurityRow[]).filter((r) =>
    ["reported", "acknowledged"].includes(String(r["status"])),
  );

  return (
    <div>
      <PageHeader
        eyebrow="Security"
        title="Security operations"
        description="Protect guests, staff and property: guards on post, patrols walked, incidents reported and resolved, and access to the property controlled."
        actions={
          <Button asChild>
            <Link to="/security/incidents">Incident reports</Link>
          </Button>
        }
      />

      <div className="neo-kpi-grid mb-6">
        <StatCard
          lead
          label="Open incidents"
          value={String(openIncidents.length)}
          hint={`${escalated.length} escalated`}
          icon={AlertTriangle}
          tone={escalated.length > 0 ? "warning" : "default"}
        />
        <StatCard label="Guards on post today" value={String(onPost.length)} icon={Users} />
        <StatCard
          label="Patrols outstanding"
          value={String(openPatrols.length)}
          icon={ShieldCheck}
          tone="accent"
        />
        <StatCard
          label="Stock needs open"
          value={String(openNeeds.length)}
          icon={PackageSearch}
          tone="warning"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="Incidents needing attention"
          description="Everything reported that is not yet resolved or closed."
          actions={
            <Button variant="ghost" size="sm" asChild>
              <Link to="/security/incidents">Open</Link>
            </Button>
          }
        >
          <QueryState
            isLoading={incidents.isLoading}
            error={incidents.error}
            isEmpty={openIncidents.length === 0}
            empty={
              <EmptyState
                title="No open incidents"
                description="Nothing is currently under investigation."
              />
            }
          >
            <div className="space-y-2">
              {openIncidents.slice(0, 8).map((r) => (
                <div
                  key={String(r["id"])}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {securityStr(r["incident_number"])} ·{" "}
                      {titleCase(securityStr(r["category"], "other"))}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {securityStr(r["location"], "Location not recorded")} ·{" "}
                      {new Date(String(r["occurred_at"])).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={securityStr(r["severity"], "low")} />
                    <SecurityStatusBadge status={String(r["status"])} />
                  </div>
                </div>
              ))}
            </div>
          </QueryState>
        </SectionCard>

        <SectionCard
          title="Patrols outstanding"
          description="Scheduled rounds that have not yet been fully walked."
          actions={
            <Button variant="ghost" size="sm" asChild>
              <Link to="/security/patrols">Open</Link>
            </Button>
          }
        >
          <QueryState
            isLoading={patrols.isLoading}
            error={patrols.error}
            isEmpty={openPatrols.length === 0}
            empty={
              <EmptyState
                title="No patrols outstanding"
                description="Every scheduled round is complete."
              />
            }
          >
            <div className="space-y-2">
              {openPatrols.slice(0, 8).map((r) => {
                const progress = patrolProgress(r["checkpoints"]);
                return (
                  <div
                    key={String(r["id"])}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">{securityStr(r["title"])}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(String(r["scheduled_for"])).toLocaleString()} · {progress.done} of{" "}
                        {progress.total} checkpoints
                      </p>
                    </div>
                    <SecurityStatusBadge status={String(r["status"])} />
                  </div>
                );
              })}
            </div>
          </QueryState>
        </SectionCard>
      </div>
    </div>
  );
}
