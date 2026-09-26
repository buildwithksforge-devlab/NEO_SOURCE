import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Building2,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import {
  useBranchMutations,
  useBranchScope,
  type BranchInput,
  type BranchRecord,
} from "@/lib/branches";
import { useTenant } from "@/lib/tenant";
import { PropertyPortalPanel } from "@/components/settings/PropertyPortalPanel";
import { EmptyState, LoadingState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/admin/branches")({
  head: () => ({
    meta: [
      { title: "Branches & Properties — System Administration" },
      {
        name: "description",
        content:
          "Create, edit, activate and brand each property or branch in your hospitality organization.",
      },
      { property: "og:title", content: "Branches & Properties — System Administration" },
      { property: "og:description", content: "Multi-property setup for hospitality groups." },
    ],
  }),
  component: BranchesPage,
});

const PROPERTY_TYPES = ["hotel", "lodge", "resort", "restaurant", "conference-centre", "other"];

const emptyForm: BranchInput = {
  name: "",
  code: "",
  property_type: "hotel",
  description: "",
  address: "",
  city: "",
  state_region: "",
  country: "",
  phone: "",
  email: "",
  timezone: "",
  currency: "",
  language: "",
  operating_hours: "",
  check_in_time: "14:00",
  check_out_time: "10:00",
  status: "active",
  is_main: false,
  active: true,
};

function BranchesPage() {
  const { branches, canManage, loading } = useBranchScope();
  const { tenant } = useTenant();
  const { create, update, remove } = useBranchMutations();
  const [editing, setEditing] = useState<BranchRecord | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <nav
        aria-label="Breadcrumb"
        className="mb-3 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
      >
        <Link to="/workspace" className="hover:text-foreground">
          Workspace
        </Link>
        <ChevronRight className="size-3" />
        <Link to="/admin" className="hover:text-foreground">
          System Administration
        </Link>
        <ChevronRight className="size-3" />
        <span className="text-foreground">Branches &amp; Properties</span>
      </nav>

      <PageHeader
        eyebrow="Business setup"
        title="Branches & Properties"
        description="One organization, many properties. Every module — PMS, POS, kitchen, stores, finance, HR and delivery — reads the properties configured here."
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Add property
            </Button>
          ) : null
        }
      />

      {loading ? (
        <SectionCard title="Properties">
          <LoadingState variant="rows" rows={3} />
        </SectionCard>
      ) : branches.length === 0 ? (
        <SectionCard title="Properties">
          <EmptyState
            icon={Building2}
            title="No properties configured"
            description={
              canManage
                ? "No properties have been configured for this organization."
                : "No properties have been configured yet. Ask an administrator to assign or configure a property."
            }
            {...(canManage
              ? {
                  action: (
                    <Button onClick={() => setCreating(true)}>
                      <Plus className="size-4" /> Add first property
                    </Button>
                  ),
                }
              : {})}
          />
        </SectionCard>
      ) : (
        <div className="space-y-6">
          {branches.map((branch) => (
            <SectionCard
              key={branch.id}
              title={branch.name}
              description={`${branch.code || "No code"} · ${branch.property_type} · ${branch.city || branch.country || "Location not set"}`}
              actions={
                <div className="flex flex-wrap items-center gap-3">
                  {branch.is_main ? (
                    <StatusPill tone="info">
                      <Star className="mr-1 inline size-3" /> Primary
                    </StatusPill>
                  ) : null}
                  <StatusPill tone={branch.active ? "success" : "warning"}>
                    {branch.active ? "Active" : "Inactive"}
                  </StatusPill>
                  {canManage ? (
                    <>
                      <Switch
                        checked={branch.active}
                        aria-label="Toggle property active"
                        onCheckedChange={(v) =>
                          update.mutate(
                            {
                              id: branch.id,
                              patch: { active: v, status: v ? "active" : "inactive" },
                              previous: { active: branch.active, status: branch.status },
                              action: v ? "branch.activated" : "branch.deactivated",
                            },
                            {
                              onSuccess: () =>
                                toast.success(v ? "Property activated" : "Property deactivated"),
                              onError: (e) => toast.error((e as Error).message),
                            },
                          )
                        }
                      />
                      <Button variant="outline" size="sm" onClick={() => setEditing(branch)}>
                        <Pencil className="size-4" /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          if (!window.confirm(`Delete ${branch.name}? This cannot be undone.`))
                            return;
                          remove.mutate(
                            { id: branch.id, previous: branch },
                            {
                              onSuccess: () => toast.success("Property deleted"),
                              onError: (e) => toast.error((e as Error).message),
                            },
                          );
                        }}
                      >
                        <Trash2 className="size-4" />
                        <span className="sr-only">Delete property</span>
                      </Button>
                    </>
                  ) : null}
                </div>
              }
            >
              <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {[
                  ["Telephone", branch.phone],
                  ["Email", branch.email],
                  ["Address", branch.address],
                  ["Town / city", branch.city],
                  ["County / state", branch.state_region],
                  ["Country", branch.country],
                  ["Timezone", branch.timezone || tenant.regional.timezone],
                  ["Currency", branch.currency || tenant.regional.currency],
                  ["Language", branch.language || tenant.regional.language],
                  ["Operating hours", branch.operating_hours],
                  ["Check-in", branch.check_in_time],
                  ["Check-out", branch.check_out_time],
                ].map(([label, value]) => (
                  <div key={label as string}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="truncate">{(value as string) || "—"}</dd>
                  </div>
                ))}
              </dl>
              {branch.description ? (
                <p className="mt-4 text-sm text-muted-foreground">{branch.description}</p>
              ) : null}
              <div className="mt-5 flex flex-wrap gap-3 text-sm">
                <Link className="text-primary hover:underline" to="/departments">
                  Assign departments
                </Link>
                <Link className="text-primary hover:underline" to="/users">
                  Assign staff
                </Link>
                <Link className="text-primary hover:underline" to="/admin/regional">
                  Regional settings
                </Link>
                <Link className="text-primary hover:underline" to="/admin/brand-identity">
                  Branding overrides
                </Link>
              </div>
              <PropertyPortalPanel branch={branch} canManage={canManage} />
            </SectionCard>
          ))}
        </div>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <Button variant="outline" asChild>
          <Link to="/admin">
            <ArrowLeft className="size-4" /> Back to System Settings
          </Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link to="/workspace">Back to workspace</Link>
        </Button>
      </div>

      <BranchDialog
        open={creating}
        title="Add property"
        description="The property is saved to your organization immediately and becomes available across every module."
        initial={emptyForm}
        primaryDefault={branches.length === 0}
        busy={create.isPending}
        onCancel={() => setCreating(false)}
        onSubmit={async (values) => {
          await create.mutateAsync(values);
          toast.success("Property created");
          setCreating(false);
        }}
      />

      <BranchDialog
        open={Boolean(editing)}
        title={`Edit ${editing?.name ?? "property"}`}
        description="Changes are saved to the shared property record used across the OS."
        initial={editing ?? emptyForm}
        busy={update.isPending}
        onCancel={() => setEditing(null)}
        onSubmit={async (values) => {
          if (!editing) return;
          await update.mutateAsync({ id: editing.id, patch: values, previous: editing });
          toast.success("Property updated");
          setEditing(null);
        }}
      />
    </div>
  );
}

function BranchDialog({
  open,
  title,
  description,
  initial,
  busy,
  primaryDefault = false,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  initial: BranchInput;
  busy: boolean;
  primaryDefault?: boolean;
  onCancel: () => void;
  onSubmit: (values: BranchInput) => Promise<void>;
}) {
  const { organizationId } = useAuth();
  const { tenant } = useTenant();
  const [form, setForm] = useState<BranchInput>(initial);

  useEffect(() => {
    if (open) setForm({ ...initial, is_main: initial.is_main ?? primaryDefault });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);
  const set = (k: keyof BranchInput, v: unknown) => setForm((p) => ({ ...p, [k]: v }));

  const close = () => {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    onCancel();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : close())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await onSubmit(form);
            } catch (err) {
              toast.error((err as Error).message);
            }
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="b-name">Property / branch name</Label>
            <Input
              id="b-name"
              required
              value={form.name ?? ""}
              onChange={(e) => set("name", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-code">Branch code</Label>
            <Input
              id="b-code"
              value={form.code ?? ""}
              onChange={(e) => set("code", e.target.value)}
              placeholder="e.g. TVT"
            />
          </div>
          <div className="space-y-2">
            <Label>Organization</Label>
            <Input
              readOnly
              value={tenant.organization.name || organizationId || "Current organization"}
            />
          </div>
          <div className="space-y-2">
            <Label>Property type</Label>
            <Select
              value={form.property_type ?? "hotel"}
              onValueChange={(v) => set("property_type", v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROPERTY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t.replace(/-/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="b-desc">Description</Label>
            <Textarea
              id="b-desc"
              rows={2}
              value={form.description ?? ""}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="b-address">Physical address</Label>
            <Input
              id="b-address"
              value={form.address ?? ""}
              onChange={(e) => set("address", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-city">Town / city</Label>
            <Input
              id="b-city"
              value={form.city ?? ""}
              onChange={(e) => set("city", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-state">County / state</Label>
            <Input
              id="b-state"
              value={form.state_region ?? ""}
              onChange={(e) => set("state_region", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-country">Country</Label>
            <Input
              id="b-country"
              value={form.country ?? ""}
              onChange={(e) => set("country", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-phone">Telephone</Label>
            <Input
              id="b-phone"
              value={form.phone ?? ""}
              onChange={(e) => set("phone", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-email">Email</Label>
            <Input
              id="b-email"
              type="email"
              value={form.email ?? ""}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-tz">Timezone</Label>
            <Input
              id="b-tz"
              value={form.timezone ?? ""}
              placeholder={tenant.regional.timezone || "Africa/Nairobi"}
              onChange={(e) => set("timezone", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-currency">Currency</Label>
            <Input
              id="b-currency"
              value={form.currency ?? ""}
              placeholder={tenant.regional.currency || "KES"}
              onChange={(e) => set("currency", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-lang">Language</Label>
            <Input
              id="b-lang"
              value={form.language ?? ""}
              placeholder={tenant.regional.language || "English"}
              onChange={(e) => set("language", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-hours">Operational hours</Label>
            <Input
              id="b-hours"
              value={form.operating_hours ?? ""}
              placeholder="e.g. 24 hours"
              onChange={(e) => set("operating_hours", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-ci">Check-in time</Label>
            <Input
              id="b-ci"
              type="time"
              value={form.check_in_time ?? "14:00"}
              onChange={(e) => set("check_in_time", e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="b-co">Check-out time</Label>
            <Input
              id="b-co"
              type="time"
              value={form.check_out_time ?? "10:00"}
              onChange={(e) => set("check_out_time", e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-muted-foreground">Available for operations</p>
            </div>
            <Switch
              checked={form.active ?? true}
              onCheckedChange={(v) => {
                set("active", v);
                set("status", v ? "active" : "inactive");
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
            <div>
              <p className="text-sm font-medium">Primary property</p>
              <p className="text-xs text-muted-foreground">Default for centralized reporting</p>
            </div>
            <Switch checked={form.is_main ?? false} onCheckedChange={(v) => set("is_main", v)} />
          </div>

          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !form.name?.trim()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Save property
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
