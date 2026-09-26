import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Download, RefreshCw, ShieldCheck, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useVisibility } from "@/lib/visibility";
import {
  ACCESS_MATRIX_VERSION,
  applyRecommendedTemplates,
  matrixToCsv,
  useAccessMatrix,
} from "@/lib/access-matrix";

export const Route = createFileRoute("/admin/access-matrix")({
  head: () => ({
    meta: [
      { title: "Access Matrix — NEØ Administration" },
      {
        name: "description",
        content:
          "Live role, permission, page, record scope, approval, cost and notification visibility matrix generated from the database.",
      },
      { property: "og:title", content: "Access Matrix — NEØ Administration" },
      {
        property: "og:description",
        content: "Compare effective access with the recommended catalogue template for every role.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AccessMatrixPage,
});

function AccessMatrixPage() {
  const { organizationId } = useAuth();
  const visibility = useVisibility();
  const { rows, loading, refetch } = useAccessMatrix();
  const [search, setSearch] = useState("");
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [grantedOnly, setGrantedOnly] = useState(true);
  const [applying, setApplying] = useState(false);

  const mayManageRoles = visibility.canAct("administration", "roles", "edit");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (grantedOnly && r.effective !== "granted" && r.recommended !== "granted") return false;
      if (differencesOnly && r.agrees) return false;
      if (!q) return true;
      return (
        r.role.toLowerCase().includes(q) ||
        r.permission.toLowerCase().includes(q) ||
        r.page.toLowerCase().includes(q) ||
        r.department.toLowerCase().includes(q) ||
        r.recordScope.includes(q)
      );
    });
  }, [rows, search, differencesOnly, grantedOnly]);

  const disagreements = useMemo(() => rows.filter((r) => !r.agrees).length, [rows]);
  const roleCount = useMemo(() => new Set(rows.map((r) => r.roleId)).size, [rows]);

  const exportCsv = () => {
    const blob = new Blob([matrixToCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `neo-access-matrix-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const applyRecommended = async () => {
    if (!organizationId) return;
    setApplying(true);
    try {
      await applyRecommendedTemplates(organizationId);
      await refetch();
      toast.success("Recommended templates applied", {
        description: "Existing custom grants were preserved and the change was audited.",
      });
    } catch (error) {
      toast.error("Could not apply templates", {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Access Matrix"
        description="Every role, capability, page, record scope, approval right, cost figure, report, task and notification — generated live from the database and compared with the recommended catalogue template."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className="size-4" /> Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!filtered.length}>
              <Download className="size-4" /> Export CSV
            </Button>
            <Button size="sm" onClick={applyRecommended} disabled={!mayManageRoles || applying}>
              <Wand2 className="size-4" /> Apply recommended
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Roles in matrix" value={String(roleCount)} />
        <StatCard label="Capability rows" value={String(rows.length)} />
        <StatCard label="Differences from recommended" value={String(disagreements)} />
        <StatCard label="Template version" value={ACCESS_MATRIX_VERSION} />
      </div>

      <SectionCard
        title="Effective access"
        description="Workspace Preview is visual only — real sign-in and row-level security remain the verification of record."
      >
        <div className="mb-4 flex flex-wrap items-center gap-4">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search role, capability, page, department or scope"
            className="max-w-sm"
          />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={differencesOnly} onCheckedChange={setDifferencesOnly} />
            Differences only
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={grantedOnly} onCheckedChange={setGrantedOnly} />
            Hide fully denied rows
          </label>
          <span className="text-xs text-muted-foreground">{filtered.length} rows</span>
        </div>

        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Loading matrix…</p>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No matching rows. Roles and grants are read from the database — nothing is simulated.
          </p>
        ) : (
          <div className="max-h-[32rem] overflow-auto rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Dashboard</TableHead>
                  <TableHead>Permission</TableHead>
                  <TableHead>Page</TableHead>
                  <TableHead>Record scope</TableHead>
                  <TableHead>Approval</TableHead>
                  <TableHead>Cost visibility</TableHead>
                  <TableHead>Tasks</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Recommended</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.slice(0, 500).map((r, i) => (
                  <TableRow key={`${r.roleId}-${r.permission}-${i}`}>
                    <TableCell className="whitespace-nowrap font-medium">{r.role}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.department}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.dashboard}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {r.permission}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs">{r.page}</TableCell>
                    <TableCell className="whitespace-nowrap capitalize">{r.recordScope}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.approval}</TableCell>
                    <TableCell className="max-w-48 truncate">{r.costVisibility}</TableCell>
                    <TableCell className="whitespace-nowrap capitalize">{r.tasks}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {r.customization !== "—" ? r.customization : r.source}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={r.effective === "granted" ? "success" : "default"}>
                        {r.effective}
                      </StatusPill>
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={r.agrees ? "info" : "warning"}>
                        {r.recommended}
                      </StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {filtered.length > 500 ? (
              <p className="border-t border-border p-3 text-center text-xs text-muted-foreground">
                Showing the first 500 rows — export to CSV for the complete matrix.
              </p>
            ) : null}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Verification"
        description="Capability disagreements block merges in continuous integration."
      >
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="size-4" />
          The exhaustive role-access-matrix test runs on every pull request; any disagreement
          between sidebar visibility, route guards and saved grants fails the build.
        </p>
      </SectionCard>
    </div>
  );
}
