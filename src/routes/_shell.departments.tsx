import { useState } from "react";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DeleteStructureRecord } from "@/components/common/DeleteStructureRecord";
import { AlertTriangle, Building, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { EmptyState, ErrorState, LoadingState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/_shell/departments")({
  head: () => ({
    meta: [
      { title: "Departments — NEØ" },
      {
        name: "description",
        content: "Configure departments, managers, branches and staffing across your properties.",
      },
      { property: "og:title", content: "Departments — NEØ" },
      {
        property: "og:description",
        content: "Configure departments, managers, branches and staffing across your properties.",
      },
    ],
  }),
  component: GuardedPage,
});

type Department = {
  id: string;
  name: string;
  code: string;
  description: string;
  manager_id: string | null;
  branch_id: string | null;
  active: boolean;
};

function DepartmentsPage() {
  const { applyTo, branchId, filterKey } = useActivePropertyFilter();
  const { organizationId, can } = useAuth();
  const canManageDepartments = can("administration", "departments", "edit");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const departments = useQuery({
    queryKey: ["departments", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      // The department registry deliberately mixes property departments with
      // organisation-wide ones, so a selected property keeps its own rows plus
      // the org-wide ones and never shows another property's departments.
      let query = supabase.from("departments").select("*, branches(name)").order("name");
      if (branchId) query = query.or(`branch_id.eq.${branchId},branch_id.is.null`);
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });

  const staff = useQuery({
    queryKey: ["profiles", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase.from("profiles").select("id, full_name, department_id"),
        "profiles",
      );
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string; department_id: string | null }[];
    },
  });

  const branches = useQuery({
    queryKey: ["branches", organizationId, filterKey],
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
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Department> }) => {
      const { error } = await supabase.from("departments").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Department updated");
      void qc.invalidateQueries({ queryKey: ["departments", organizationId, filterKey] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        eyebrow="Organization"
        title="Departments"
        description="Procurement sources and buys. Stores receives, holds, issues and controls stock. They stay separate."
        actions={
          canManageDepartments ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="size-4" /> Add department
            </Button>
          ) : null
        }
      />

      {/*
        A query disabled while the workspace context resolves is pending but not
        fetching, so `isLoading` is false and `data` is undefined. Without this
        guard the page rendered only its heading — neither list, empty state nor
        loader. Treat "no result yet" as still loading.
      */}
      {departments.isLoading || (!departments.isError && !departments.data) ? (
        <LoadingState variant="cards" rows={3} />
      ) : departments.isError ? (
        <ErrorState error={departments.error} title="Could not load departments" />
      ) : null}


      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(departments.data ?? []).map((raw) => {
          const d = raw as unknown as Department & { branches: { name: string } | null };
          const members = (staff.data ?? []).filter((s) => s.department_id === d.id);
          return (
            <div key={d.id} className="surface-panel space-y-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{d.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {d.code || "—"} · {d.branches?.name ?? "All branches"}
                  </p>
                </div>
                <StatusPill tone={d.active ? "success" : "warning"}>
                  {d.active ? "Active" : "Inactive"}
                </StatusPill>
              </div>


              <p className="text-sm text-muted-foreground">
                {d.description ||
                  "Dashboard, notifications, reports and tasks are prepared for this department."}
              </p>

              <div className="space-y-2">
                <Label className="text-xs">Department manager</Label>
                <Select
                  value={d.manager_id ?? ""}
                  disabled={!canManageDepartments}
                  onValueChange={(v) => update.mutate({ id: d.id, patch: { manager_id: v } })}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    {(staff.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.full_name || "Unnamed"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-sm">
                <span className="text-muted-foreground">{members.length} staff assigned</span>
                {canManageDepartments ? (
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      Active
                      <Switch
                        checked={d.active}
                        onCheckedChange={(v) => update.mutate({ id: d.id, patch: { active: v } })}
                      />
                    </label>
                    <DeleteStructureRecord
                      kind="department"
                      id={d.id}
                      name={d.name}
                      invalidateKeys={[["departments", organizationId, filterKey]]}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {!departments.isLoading && !departments.isError && departments.data?.length === 0 ? (
        <EmptyState
          icon={Building}
          title="No departments yet"
          description="Create your first department to get started."
        />
      ) : null}

      <AddDepartmentDialog
        open={open}
        onOpenChange={setOpen}
        branches={branches.data ?? []}
        onCreate={async (payload) => {
          if (!organizationId)
            throw new Error("Your organization context is still loading. Please try again.");
          const { error } = await supabase
            .from("departments")
            .insert({ organization_id: organizationId, ...payload });
          if (error) throw error;
          void qc.invalidateQueries({ queryKey: ["departments", organizationId, filterKey] });
        }}
      />
    </div>
  );
}

function AddDepartmentDialog({
  open,
  onOpenChange,
  branches,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  branches: { id: string; name: string }[];
  onCreate: (payload: {
    name: string;
    code: string;
    description: string;
    branch_id: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [branchId, setBranchId] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await onCreate({ name, code, description, branch_id: branchId || null });
      toast.success("Department created");
      onOpenChange(false);
      setName("");
      setCode("");
      setDescription("");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add department</DialogTitle>
          <DialogDescription>Departments own tasks, notifications and reports.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="dname">Name</Label>
            <Input id="dname" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dcode">Code</Label>
            <Input id="dcode" value={code} onChange={(e) => setCode(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ddesc">Description</Label>
            <Textarea
              id="ddesc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Branch</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger>
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Create department</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/departments">
      <DepartmentsPage />
    </OpsGuard>
  );
}
