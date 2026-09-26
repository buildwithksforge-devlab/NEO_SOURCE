import { guardedRpc } from "@/lib/rpc-guard";
import { LoadingState } from "@/components/common/StateSystem";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { Plus, Download, Crown, Users } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
import { Avatar } from "@/components/common/AvatarDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import {
  CatalogueGroup,
  CatalogueQueryBar,
  CatalogueRail,
  CatalogueRow,
  CatalogueWorkspace,
  type ActiveFilterChip,
} from "@/components/common/CatalogueWorkspace";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { EmptyState, QueryState } from "@/components/common/StateSystem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useWriteBranchId } from "@/lib/branch-filter";
import { logAudit } from "@/lib/audit";
import {
  CUSTOMER_TYPES,
  recordTimelineEvent,
  titleCase,
  useCustomers,
  useInvalidateCrm,
  type Customer,
} from "@/lib/crm";

export const Route = createFileRoute("/_shell/crm/customers/")({
  head: () => ({
    meta: [
      { title: "Customer Directory — Guest CRM" },
      {
        name: "description",
        content:
          "Search, filter and manage every guest, diner, delivery and corporate customer in one unified directory.",
      },
      { property: "og:title", content: "Customer Directory — Guest CRM" },
      {
        property: "og:description",
        content: "One unified profile for every hospitality customer.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

const emptyForm = {
  full_name: "",
  preferred_name: "",
  customer_type: "individual-guest",
  phone: "",
  email: "",
  nationality: "",
  city: "",
  country: "",
  company: "",
  date_of_birth: "",
  marketing_consent: false,
};

/** Data-quality lenses surfaced by the summary strip. */
type Lens = "none" | "vip" | "unlinked" | "blocked";

function Page() {
  const { profile, user, isAdmin, can } = useAuth();
  const writeBranchId = useWriteBranchId();
  const invalidate = useInvalidateCrm();
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [status, setStatus] = useState("all");
  const [lens, setLens] = useState<Lens>("none");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [inspectId, setInspectId] = useState<string | null>(null);

  const { data: customers, isLoading } = useCustomers();
  const allCustomers = customers ?? [];
  const canCreate = can("crm-customers", "create");
  const canExport = can("crm-customers", "export");

  const vipCount = allCustomers.filter((c) => c.is_vip).length;
  const unlinkedCount = allCustomers.filter((c) => !c.auth_user_id).length;
  const blockedCount = allCustomers.filter((c) => c.account_status === "blocked").length;

  const toggleLens = (next: Lens) => setLens((prev) => (prev === next ? "none" : next));

  const term = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      allCustomers.filter(
        (c) =>
          (type === "all" || c.customer_type === type) &&
          (status === "all" || c.account_status === status) &&
          (lens === "none" ||
            (lens === "vip" ? c.is_vip : lens === "unlinked" ? !c.auth_user_id : c.account_status === "blocked")) &&
          (!term ||
            c.full_name.toLowerCase().includes(term) ||
            (c.customer_number ?? "").toLowerCase().includes(term) ||
            (c.phone ?? "").toLowerCase().includes(term) ||
            (c.email ?? "").toLowerCase().includes(term) ||
            (c.company ?? "").toLowerCase().includes(term)),
      ),
    [allCustomers, type, status, lens, term],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, Customer[]>();
    for (const row of filtered) {
      const key = titleCase(row.customer_type);
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const railItems = CUSTOMER_TYPES.map((t) => ({
    id: t,
    label: titleCase(t),
    count: allCustomers.filter((c) => c.customer_type === t).length,
  }));

  const activeFilters: ActiveFilterChip[] = [];
  if (type !== "all")
    activeFilters.push({ id: "type", label: titleCase(type), onClear: () => setType("all") });
  if (status !== "all")
    activeFilters.push({ id: "status", label: titleCase(status), onClear: () => setStatus("all") });
  if (lens !== "none")
    activeFilters.push({
      id: "lens",
      label: lens === "vip" ? "VIP only" : lens === "unlinked" ? "Portal not linked" : "Blocked",
      onClear: () => setLens("none"),
    });

  const clearAll = () => {
    setType("all");
    setStatus("all");
    setLens("none");
  };

  const inspected = filtered.find((c) => c.id === inspectId) ?? null;

  async function createCustomer() {
    if (!profile?.organization_id || !form.full_name.trim()) return;
    setSaving(true);
    // Resolve first: an existing guest with the same phone/email is reused, never duplicated.
    const { data: resolvedId, error } = await guardedRpc(supabase, "neo_customer_resolve", {
      _org: profile.organization_id,
      _branch: writeBranchId as string,
      _full_name: form.full_name.trim(),
      ...(form.phone.trim() ? { _phone: form.phone.trim() } : {}),
      ...(form.email.trim() ? { _email: form.email.trim() } : {}),
    });
    if (error || !resolvedId) {
      setSaving(false);
      toast.error(error?.message ?? "Could not resolve the guest profile");
      return;
    }
    const data = { id: resolvedId as string };
    await supabase
      .from("customers")
      .update({
        preferred_name: form.preferred_name.trim(),
        customer_type: form.customer_type,
        nationality: form.nationality.trim(),
        city: form.city.trim(),
        country: form.country.trim(),
        company: form.company.trim(),
        date_of_birth: form.date_of_birth || null,
        marketing_consent: form.marketing_consent,
        source: "staff-entry",
      })
      .eq("id", data.id);
    setSaving(false);
    await recordTimelineEvent({
      organizationId: profile.organization_id,
      customerId: data.id,
      eventType: "customer-created",
      description: `Customer profile created by ${profile.full_name}.`,
      staffUserId: user?.id ?? null,
    });
    await supabase.from("customer_consents").insert({
      organization_id: profile.organization_id,
      customer_id: data.id,
      consent_type: "email-marketing",
      granted: form.marketing_consent,
      consent_source: "staff-entry",
      consent_wording: "Marketing consent captured at profile creation.",
      recorded_by: user?.id ?? null,
    });
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.customer.create",
      module: "crm-customers",
      recordId: data.id,
      newValue: { full_name: form.full_name.trim(), customer_type: form.customer_type },
    });
    toast.success("Customer profile created");
    setForm(emptyForm);
    setOpen(false);
    invalidate();
  }

  async function exportCsv() {
    if (!filtered.length) return;
    const header = [
      "Customer ID",
      "Name",
      "Type",
      "Phone",
      "Email",
      "City",
      "Country",
      "VIP",
      "Status",
      "Marketing consent",
    ];
    const rows = filtered.map((c) => [
      c.customer_number,
      c.full_name,
      titleCase(c.customer_type),
      c.phone,
      c.email,
      c.city,
      c.country,
      c.is_vip ? "Yes" : "No",
      c.account_status,
      c.marketing_consent ? "Yes" : "No",
    ]);
    const csv = [header, ...rows]
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    await logAudit({
      organizationId: profile?.organization_id ?? null,
      userId: user?.id ?? null,
      userName: profile?.full_name,
      action: "crm.customer.export",
      module: "crm-customers",
      reason: "Directory export",
      newValue: { rows: rows.length, type, status },
    });
    toast.success("Export recorded in the audit trail");
  }

  const leadFigure: SummaryFigure = {
    id: "total",
    label: "Customers",
    value: isLoading ? "…" : allCustomers.length,
    hint: "One profile per person or organisation",
  };
  const figures: SummaryFigure[] = [
    {
      id: "vip",
      label: "VIP",
      value: isLoading ? "…" : vipCount,
      tone: vipCount ? "accent" : "default",
      onSelect: () => toggleLens("vip"),
      active: lens === "vip",
    },
    {
      id: "unlinked",
      label: "Portal not linked",
      value: isLoading ? "…" : unlinkedCount,
      tone: "info",
      onSelect: () => toggleLens("unlinked"),
      active: lens === "unlinked",
    },
    {
      id: "blocked",
      label: "Blocked",
      value: isLoading ? "…" : blockedCount,
      tone: blockedCount ? "warning" : "success",
      onSelect: () => toggleLens("blocked"),
      active: lens === "blocked",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Guest CRM"
        title="Customer Directory"
        description="One profile per person or organisation. Identity documents are stored separately and never shown in lists or exports."
        actions={
          <>
            {canExport ? (
              <Button size="sm" variant="outline" onClick={exportCsv}>
                <Download className="mr-2 size-4" /> Export
              </Button>
            ) : null}
            {canCreate ? (
              <Button size="sm" onClick={() => setOpen(true)}>
                <Plus className="mr-2 size-4" /> Add customer
              </Button>
            ) : null}
          </>
        }
      />

      <SummaryStrip lead={leadFigure} figures={figures} />

      <CatalogueWorkspace
        rail={
          <CatalogueRail
            title="Customer type"
            items={railItems}
            value={type}
            onChange={setType}
            allLabel="All types"
            allCount={allCustomers.length}
          />
        }
      >
        <CatalogueQueryBar
          search={search}
          onSearch={setSearch}
          placeholder="Name, customer ID, phone, email or company"
          activeFilters={activeFilters}
          onClearAll={activeFilters.length ? clearAll : undefined}
          filters={
            <div className="space-y-1.5">
              <Label>Account status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger aria-label="Filter by account status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                  <SelectItem value="blocked">Blocked</SelectItem>
                </SelectContent>
              </Select>
            </div>
          }
        />

        <QueryState
          isLoading={isLoading}
          error={null}
          isEmpty={allCustomers.length === 0}
          empty={
            <EmptyState
              icon={Users}
              title="No customer profiles yet"
              description="Create the first profile, or they will appear automatically as operational modules start recording guests."
            />
          }
        >
          {isLoading ? (
            <LoadingState variant="rows" rows={5} />
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No customers match the current filters.
            </p>
          ) : (
            <div className="min-w-0">
              {grouped.map(([groupName, rows]) => (
                <CatalogueGroup key={groupName} label={groupName} count={rows.length}>
                  {rows.map((c) => (
                    <CatalogueRow
                      key={c.id}
                      selected={inspectId === c.id}
                      onOpen={() => setInspectId(c.id)}
                      media={<Avatar path={null} name={c.full_name} size={40} />}
                      title={c.full_name}
                      subtitle={[c.customer_number, c.phone || c.email].filter(Boolean).join(" · ")}
                      chips={
                        <>
                          {c.is_vip ? <StatusPill tone="accent">VIP</StatusPill> : null}
                          <StatusPill tone={c.account_status === "active" ? "success" : "default"}>
                            {titleCase(c.account_status)}
                          </StatusPill>
                          <StatusPill tone={c.auth_user_id ? "success" : "default"}>
                            {c.auth_user_id ? "Portal linked" : "Not linked"}
                          </StatusPill>
                        </>
                      }
                      trailing={
                        c.last_interaction_at
                          ? new Date(c.last_interaction_at).toLocaleDateString()
                          : "No interaction"
                      }
                    />
                  ))}
                </CatalogueGroup>
              ))}
            </div>
          )}
        </QueryState>
      </CatalogueWorkspace>

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(o) => !o && setInspectId(null)}
        title={inspected?.full_name ?? ""}
        subtitle={inspected?.customer_number}
        media={<Avatar path={null} name={inspected?.full_name} size={44} />}
        chips={
          inspected ? (
            <>
              {inspected.is_vip ? <StatusPill tone="accent">VIP</StatusPill> : null}
              <StatusPill tone={inspected.account_status === "active" ? "success" : "default"}>
                {titleCase(inspected.account_status)}
              </StatusPill>
            </>
          ) : null
        }
        footer={
          inspected ? (
            <Button asChild>
              <Link to="/crm/customers/$id" params={{ id: inspected.id }}>
                Open full profile
              </Link>
            </Button>
          ) : null
        }
      >
        {inspected ? (
          <>
            <InspectorSection title="Contact">
              <InspectorField label="Phone">{inspected.phone || "—"}</InspectorField>
              <InspectorField label="Email">{inspected.email || "—"}</InspectorField>
              <InspectorField label="Location">
                {[inspected.city, inspected.country].filter(Boolean).join(", ") || "—"}
              </InspectorField>
              <InspectorField label="Company">{inspected.company || "—"}</InspectorField>
            </InspectorSection>
            <InspectorSection title="Account">
              <InspectorField label="Type">{titleCase(inspected.customer_type)}</InspectorField>
              <InspectorField label="Portal">
                {inspected.auth_user_id ? "Linked" : "Not linked"}
              </InspectorField>
              <InspectorField label="Marketing consent">
                {inspected.marketing_consent ? "Given" : "Not given"}
              </InspectorField>
              <InspectorField label="Last interaction">
                {inspected.last_interaction_at
                  ? new Date(inspected.last_interaction_at).toLocaleDateString()
                  : "No recorded interaction"}
              </InspectorField>
            </InspectorSection>
          </>
        ) : null}
      </InspectorSheet>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add customer</DialogTitle>
            <DialogDescription>
              A CRM profile can exist without an online account. The Guest Portal can be linked
              later through a verified process.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Field label="Full name">
              <Input
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
              />
            </Field>
            <Field label="Preferred name">
              <Input
                value={form.preferred_name}
                onChange={(e) => setForm({ ...form, preferred_name: e.target.value })}
              />
            </Field>
            <Field label="Customer type">
              <Select
                value={form.customer_type}
                onValueChange={(v) => setForm({ ...form, customer_type: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOMER_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {titleCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Phone">
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </Field>
              <Field label="Email">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </Field>
              <Field label="Nationality">
                <Input
                  value={form.nationality}
                  onChange={(e) => setForm({ ...form, nationality: e.target.value })}
                />
              </Field>
              <Field label="Date of birth">
                <NeoDatePicker
                  value={form.date_of_birth}
                  onChange={(iso) => setForm({ ...form, date_of_birth: iso })}
                />
              </Field>
              <Field label="City">
                <Input
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                />
              </Field>
              <Field label="Country">
                <Input
                  value={form.country}
                  onChange={(e) => setForm({ ...form, country: e.target.value })}
                />
              </Field>
            </div>
            <Field label="Company (optional)">
              <Input
                value={form.company}
                onChange={(e) => setForm({ ...form, company: e.target.value })}
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.marketing_consent}
                onChange={(e) => setForm({ ...form, marketing_consent: e.target.checked })}
              />
              Customer has given marketing consent
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createCustomer} disabled={saving || !form.full_name.trim()}>
              {saving ? "Saving…" : "Create customer"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/crm/customers">
      <Page />
    </OpsGuard>
  );
}
