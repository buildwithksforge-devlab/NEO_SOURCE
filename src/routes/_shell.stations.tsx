import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, MapPin, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  menuDepartmentsForBranch,
  type MenuDepartment,
} from "@/lib/menu-scoping";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/stations")({
  head: () => ({
    meta: [
      { title: "Stations — NEØ" },
      {
        name: "description",
        content: "View and assign operational stations across departments and properties.",
      },
      { property: "og:title", content: "Stations — NEØ" },
      {
        property: "og:description",
        content: "View and assign operational stations across departments and properties.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Station = {
  id: string;
  name: string;
  code: string;
  station_type: string;
  department_id: string | null;
  branch_id: string | null;
  active: boolean;
  departments: { name: string } | null;
  branches: { name: string } | null;
};

function StationsPage() {
  const { organizationId, isAdmin, profile, user } = useAuth();
  const qc = useQueryClient();
  const [showInactive, setShowInactive] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  // Station and department registries are excluded from the shared branch
  // filter because selectors need organisation-wide rows; this page scopes
  // itself so a selected property never lists another property's records.
  const { branchId } = useActivePropertyFilter();

  const stations = useQuery({
    queryKey: ["operational-stations", organizationId, branchId ?? "all"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let query = supabase
        .from("operational_stations")
        .select(
          "id, name, code, station_type, department_id, branch_id, active, departments(name), branches(name)",
        )
        .order("sort_order")
        .order("name");
      if (branchId) query = query.or(`branch_id.eq.${branchId},branch_id.is.null`);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as Station[];
    },
  });

  // Every department in the workspace, filtered per station below so the
  // property is always chosen first and only that property's departments are
  // offered (organisation-wide departments remain valid everywhere).
  const departments = useQuery({
    queryKey: ["departments", organizationId, branchId ?? "all", "station-chain-options"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let query = supabase
        .from("departments")
        .select("id, name, catalogue_key, branch_id, active")
        .order("name");
      if (branchId) query = query.or(`branch_id.eq.${branchId},branch_id.is.null`);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as unknown as MenuDepartment[];
    },
  });

  const branches = useQuery({
    queryKey: ["branches", organizationId, branchId ?? "all", "station-options"],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      let query = supabase.from("branches").select("id, name").order("name");
      if (branchId) query = query.eq("id", branchId);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as { id: string; name: string }[];
    },
  });

  const update = useMutation({
    mutationFn: async ({ station, patch }: { station: Station; patch: Partial<Station> }) => {
      const { error } = await supabase
        .from("operational_stations")
        .update(patch as never)
        .eq("id", station.id);
      if (error) throw error;
      await logAudit({
        organizationId,
        userId: user?.id ?? null,
        userName: profile?.full_name,
        action: "station.updated",
        module: "administration",
        recordId: station.id,
        previousValue: station,
        newValue: patch,
        branchId: patch.branch_id === undefined ? station.branch_id : patch.branch_id,
        departmentId:
          patch.department_id === undefined ? station.department_id : patch.department_id,
      });
    },
    onSuccess: () => {
      toast.success("Station updated");
      void qc.invalidateQueries({ queryKey: ["operational-stations"] });
      void qc.invalidateQueries({ queryKey: ["pos", "stations"] });
      void qc.invalidateQueries({ queryKey: ["kitchen", "stations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const create = useMutation({
    mutationFn: async (payload: {
      name: string;
      code: string;
      station_type: string;
      branch_id: string;
      department_id: string;
    }) => {
      if (!organizationId) throw new Error("No active workspace");
      const { data, error } = await supabase
        .from("operational_stations")
        .insert({ organization_id: organizationId, ...payload } as never)
        .select("id")
        .single();
      if (error) throw error;
      await logAudit({
        organizationId,
        userId: user?.id ?? null,
        userName: profile?.full_name,
        action: "station.created",
        module: "administration",
        recordId: (data as { id: string }).id,
        newValue: payload,
        branchId: payload.branch_id,
        departmentId: payload.department_id,
      });
    },
    onSuccess: () => {
      toast.success("Station created");
      setAddOpen(false);
      void qc.invalidateQueries({ queryKey: ["operational-stations"] });
      void qc.invalidateQueries({ queryKey: ["pos", "stations"] });
      void qc.invalidateQueries({ queryKey: ["kitchen", "stations"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const visible = (stations.data ?? []).filter((station) => showInactive || station.active);

  return (
    <div>
      <PageHeader
        eyebrow="Organization"
        title="Stations"
        description="Operational service points and their department and property assignments."
      />

      <div className="mb-4 flex flex-wrap items-center justify-end gap-3 text-sm text-muted-foreground">
        <Label htmlFor="show-inactive-stations">Show inactive</Label>
        <Switch
          id="show-inactive-stations"
          checked={showInactive}
          onCheckedChange={setShowInactive}
        />
        {isAdmin ? (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="mr-1 size-4" /> Add station
          </Button>
        ) : null}
      </div>

      {isAdmin ? (
        <AddStationDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          branches={branches.data ?? []}
          departments={departments.data ?? []}
          pending={create.isPending}
          onCreate={(payload) => create.mutate(payload)}
        />
      ) : null}

      {stations.isLoading || (!stations.isError && !stations.data) ? (
        <LoadingState variant="cards" rows={3} />

      ) : stations.isError ? (
        <ErrorState error={stations.error} title="Could not load stations" />
      ) : visible.length === 0 ? (
        <EmptyState icon={MapPin} title="No stations found" description="No existing station records match this view." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((station) => {
            // Property first, then that property's departments — the same chain
            // the database now enforces on write.
            const options = menuDepartmentsForBranch(departments.data ?? [], station.branch_id);
            const chainBroken =
              !station.branch_id ||
              !station.department_id ||
              !options.some((d) => d.id === station.department_id);
            return (
            <div key={station.id} className="surface-panel space-y-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{station.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {station.code || "—"} · {station.station_type}
                  </p>

                </div>
                <StatusPill tone={station.active ? "success" : "warning"}>
                  {station.active ? "Active" : "Inactive"}
                </StatusPill>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-xs">Property</Label>
                  <Select
                    value={station.branch_id ?? "org"}
                    disabled={!isAdmin}
                    onValueChange={(value) => {
                      const branch_id = value === "org" ? null : value;
                      // A department that does not belong to the new property is
                      // dropped rather than silently kept.
                      const stillValid = menuDepartmentsForBranch(
                        departments.data ?? [],
                        branch_id,
                      ).some((d) => d.id === station.department_id);
                      update.mutate({
                        station,
                        patch: stillValid
                          ? { branch_id }
                          : { branch_id, department_id: null },
                      });
                    }}
                  >
                    <SelectTrigger className="h-9" aria-label={`Property for ${station.name}`}>
                      <SelectValue placeholder="Select property" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="org">All properties</SelectItem>
                      {(branches.data ?? []).map((branch) => (
                        <SelectItem key={branch.id} value={branch.id}>
                          {branch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Department</Label>
                  <Select
                    value={station.department_id ?? "org"}
                    disabled={!isAdmin || !station.branch_id}
                    onValueChange={(value) =>
                      update.mutate({
                        station,
                        patch: { department_id: value === "org" ? null : value },
                      })
                    }
                  >
                    <SelectTrigger className="h-9" aria-label={`Department for ${station.name}`}>
                      <SelectValue
                        placeholder={
                          station.branch_id ? "Select department" : "Select a property first"
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="org">Unassigned</SelectItem>
                      {options.map((department) => (
                        <SelectItem key={department.id} value={department.id}>
                          {department.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {chainBroken ? (
                <p
                  data-station-chain-warning
                  className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
                >
                  Configuration incomplete — this station needs a property and one of that
                  property&apos;s departments before it can receive production work.
                </p>
              ) : null}


              <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                <span>
                  {station.departments?.name ?? "No department"} ·{" "}
                  {station.branches?.name ?? "All properties"}
                </span>
                {isAdmin ? (
                  <label className="flex items-center gap-2">
                    Active
                    <Switch
                      checked={station.active}
                      onCheckedChange={(active) => update.mutate({ station, patch: { active } })}
                    />
                  </label>
                ) : null}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddStationDialog({
  open,
  onOpenChange,
  branches,
  departments,
  pending,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  branches: { id: string; name: string }[];
  departments: MenuDepartment[];
  pending: boolean;
  onCreate: (payload: {
    name: string;
    code: string;
    station_type: string;
    branch_id: string;
    department_id: string;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [stationType, setStationType] = useState("service");
  const [branchId, setBranchId] = useState("");
  const [departmentId, setDepartmentId] = useState("");

  // Property first, then only that property's departments — the same chain the
  // database enforces, so a new station is never created half-assigned.
  const options = menuDepartmentsForBranch(departments, branchId || null);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!branchId || !departmentId) {
      toast.error("Choose a property and one of its departments");
      return;
    }
    onCreate({
      name: name.trim(),
      code: code.trim() || name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-"),
      station_type: stationType,
      branch_id: branchId,
      department_id: departmentId,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add station</DialogTitle>
          <DialogDescription>
            Stations receive production and service work for one department at one property.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="station-name">Name</Label>
            <Input
              id="station-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="station-code">Code</Label>
            <Input
              id="station-code"
              value={code}
              placeholder="Derived from the name when left blank"
              onChange={(event) => setCode(event.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Property</Label>
              <Select
                value={branchId}
                onValueChange={(value) => {
                  setBranchId(value);
                  setDepartmentId("");
                }}
              >
                <SelectTrigger aria-label="Station property">
                  <SelectValue placeholder="Select property" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Department</Label>
              <Select value={departmentId} onValueChange={setDepartmentId} disabled={!branchId}>
                <SelectTrigger aria-label="Station department">
                  <SelectValue
                    placeholder={branchId ? "Select department" : "Select a property first"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {options.map((department) => (
                    <SelectItem key={department.id} value={department.id}>
                      {department.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Station type</Label>
            <Select value={stationType} onValueChange={setStationType}>
              <SelectTrigger aria-label="Station type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="service">Service</SelectItem>
                <SelectItem value="production">Production</SelectItem>
                <SelectItem value="bar">Bar</SelectItem>
                <SelectItem value="support">Support</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
              Create station
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/stations">
      <StationsPage />
    </OpsGuard>
  );
}
