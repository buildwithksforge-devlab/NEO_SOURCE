import { LoadingState } from "@/components/common/StateSystem";
import { useMemo } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw } from "lucide-react";
import { PageHeader, SectionCard, StatCard } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  menuIssueLabels,
  menuStateLabels,
  readinessLabels,
  useGoLiveReadiness,
  useMenuValidationStates,
  type ReadinessCheck,
  type ReadinessStatus,
} from "@/lib/go-live";
import { useSeedApprovalAuthority } from "@/lib/finance-controls";

export const Route = createFileRoute("/admin/go-live")({
  head: () => ({
    meta: [
      { title: "Go-Live Readiness — NEØ Administration" },
      {
        name: "description",
        content:
          "Certify that Point of Sale, kitchen routing, menus, housekeeping staffing, approvals, finance periods, rider identities and event billing are operationally complete before a property goes live.",
      },
      { property: "og:title", content: "Go-Live Readiness — NEØ Administration" },
      {
        property: "og:description",
        content: "Workspace readiness proof across every canonical business relationship.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: GoLivePage,
});

const statusTone: Record<ReadinessStatus, string> = {
  ready: "bg-success/15 text-success-foreground border-success/30",
  attention: "bg-warning/15 text-on-tint-warning border-warning/30",
  blocked: "bg-destructive/10 text-destructive border-destructive/30",
  unknown: "bg-muted text-muted-foreground border-border",
};

function StatusIcon({ status }: { status: ReadinessStatus }) {
  if (status === "ready") return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />;
  if (status === "attention") return <AlertTriangle className="h-4 w-4 text-warning" aria-hidden />;
  return <XCircle className="h-4 w-4 text-destructive" aria-hidden />;
}

function CheckRow({
  check,
  onSeedApprovals,
  seeding,
}: {
  check: ReadinessCheck;
  onSeedApprovals: () => void;
  seeding: boolean;
}) {
  const canSeed = check.key === "approvals" && check.status !== "ready";
  return (
    <TableRow>
      <TableCell className="align-top">
        <span className="flex items-center gap-2 text-sm font-medium">
          <StatusIcon status={check.status} />
          {check.label}
        </span>
        <span className="block text-xs text-muted-foreground">{check.domain}</span>
      </TableCell>
      <TableCell className="align-top text-sm">{check.detail}</TableCell>
      <TableCell className="align-top">
        <Badge variant="outline" className={statusTone[check.status]}>
          {readinessLabels[check.status]}
        </Badge>
      </TableCell>
      <TableCell className="align-top text-right">
        <div className="flex flex-wrap justify-end gap-2">
          {canSeed ? (
            <Button size="sm" onClick={onSeedApprovals} disabled={seeding}>
              Seed baseline authority
            </Button>
          ) : null}
          <Button asChild size="sm" variant="outline">
            <Link to={check.route as never}>Open</Link>
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function GoLivePage() {
  const readiness = useGoLiveReadiness();
  const menu = useMenuValidationStates();
  const seedAuthority = useSeedApprovalAuthority();

  const checks = readiness.data?.checks ?? [];
  const counts = useMemo(
    () => ({
      ready: checks.filter((c) => c.status === "ready").length,
      attention: checks.filter((c) => c.status === "attention").length,
      blocked: checks.filter((c) => c.status === "blocked").length,
    }),
    [checks],
  );

  const menuRows = menu.data ?? [];
  const incomplete = menuRows.filter((row) => row.state !== "ready");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Go-Live Readiness"
        description="A property is only ready when the underlying business relationships are complete — not because the pages exist. Every check below is evaluated against live records for the selected property."
        actions={
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted-foreground">
              {readiness.isFetching
                ? "Checking now…"
                : readiness.data
                  ? `Checks itself every 2 minutes · last checked ${new Date(readiness.data.generated_at).toLocaleTimeString()}`
                  : "Checks itself every 2 minutes"}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void readiness.refetch();
                void menu.refetch();
              }}
              disabled={readiness.isFetching}
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
              Re-run now
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Overall" value={readinessLabels[readiness.data?.status ?? "unknown"]} />
        <StatCard label="Ready" value={String(counts.ready)} />
        <StatCard label="Needs attention" value={String(counts.attention)} />
        <StatCard label="Blocked" value={String(counts.blocked)} />
      </div>

      <Tabs defaultValue="checks">
        <TabsList>
          <TabsTrigger value="checks">Readiness checks</TabsTrigger>
          <TabsTrigger value="menu">Menu master data</TabsTrigger>
        </TabsList>

        <TabsContent value="checks" className="mt-4">
          <SectionCard
            title="Operational readiness"
            description="POS → KDS, menu → recipe → station, employee → rider, event → billing → finance."
          >
            {readiness.isLoading ? (
              <LoadingState variant="rows" rows={3} />
            ) : checks.length === 0 ? (
              <p className="text-sm text-muted-foreground">No readiness signals available for this property yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Check</TableHead>
                      <TableHead>Finding</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {checks.map((check) => (
                      <CheckRow
                        key={check.key}
                        check={check}
                        seeding={seedAuthority.isPending}
                        onSeedApprovals={() =>
                          seedAuthority.mutate(undefined, {
                            onSuccess: () => {
                              void readiness.refetch();
                            },
                          })
                        }
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent value="menu" className="mt-4">
          <SectionCard
            title="Imported menu validation"
            description="Imported data may exist without being operationally complete. Every item below is graded against images, categories, stations, recipes and pricing."
          >
            {menu.isLoading ? (
              <LoadingState variant="rows" rows={3} />
            ) : menuRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No menu items for this property yet. Import a menu file to create the master records.
              </p>
            ) : incomplete.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                All {menuRows.length} menu items are fully mapped and operationally ready.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Outstanding</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {incomplete.map((row) => (
                      <TableRow key={row.item_id}>
                        <TableCell className="align-top text-sm font-medium">{row.name}</TableCell>
                        <TableCell className="align-top">
                          <Badge variant="outline">{menuStateLabels[row.state] ?? row.state}</Badge>
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-wrap gap-1">
                            {row.issues.map((issue) => (
                              <Badge key={issue} variant="secondary" className="text-[11px]">
                                {menuIssueLabels[issue] ?? issue}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
