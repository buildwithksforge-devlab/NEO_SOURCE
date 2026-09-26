import { useMemo, useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { Plus, Building2 } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, StatusPill } from "@/components/common/DataDisplay";
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
import { Textarea } from "@/components/ui/textarea";
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
  CORPORATE_TYPES,
  referenceFor,
  titleCase,
  useCorporateAccounts,
  useInvalidateCrm,
} from "@/lib/crm";

export const Route = createFileRoute("/_shell/crm/corporate")({
  head: () => ({
    meta: [
      { title: "Corporate Accounts — Guest CRM" },
      {
        name: "description",
        content:
          "Companies, NGOs, schools, hospitals and travel partners with contacts, credit settings and approval-controlled limits.",
      },
      { property: "og:title", content: "Corporate Accounts — Guest CRM" },
      {
        property: "og:description",
        content: "Corporate clients, contacts and credit control for hospitality groups.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type AccountRow = {
  id: string;
  account_number: string;
  legal_name: string;
  trading_name: string;
  account_type: string;
  email: string;
  phone: string;
  account_status: string;
  corporate_contacts: {
    id: string;
    full_name: string;
    job_title: string;
    email: string;
    is_primary: boolean;
  }[];
  corporate_credit_settings: {
    credit_status: string;
    credit_limit: number;
    outstanding_balance: number;
    payment_terms_days: number;
  } | null;
};

/** Data-quality lenses surfaced by the summary strip. */
type Lens = "none" | "on-hold" | "no-contacts";

function Page() {
  const { profile, user, isAdmin, can } = useAuth();
  const writeBranchId = useWriteBranchId();
  const invalidate = useInvalidateCrm();
  const { data, isLoading, refetch } = useCorporateAccounts();
  const accounts = (data ?? []) as unknown as AccountRow[];

  const [search, setSearch] = useState("");
  const [typeRail, setTypeRail] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [lens, setLens] = useState<Lens>("none");
  const [inspectId, setInspectId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [contactFor, setContactFor] = useState<AccountRow | null>(null);
  const [creditFor, setCreditFor] = useState<AccountRow | null>(null);
  const [form, setForm] = useState({
    legal_name: "",
    trading_name: "",
    account_type: "company",
    email: "",
    phone: "",
    industry: "",
    notes: "",
  });
  const [contact, setContact] = useState({
    full_name: "",
    job_title: "",
    email: "",
    phone: "",
    is_primary: false,
  });
  const [credit, setCredit] = useState({ limit: "", terms: "30", reason: "" });

  const canManage = can("crm-corporate", "edit");
  const canRequestCredit = can("crm-credit", "create");

  const onHoldCount = accounts.filter(
    (a) => (a.corporate_credit_settings?.credit_status ?? "on-hold") === "on-hold",
  ).length;
  const noContactsCount = accounts.filter((a) => !a.corporate_contacts?.length).length;

  const toggleLens = (next: Lens) => setLens((prev) => (prev === next ? "none" : next));

  const term = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      accounts.filter(
        (a) =>
          (typeRail === "all" || a.account_type === typeRail) &&
          (statusFilter === "all" || a.account_status === statusFilter) &&
          (lens === "none" ||
            (lens === "on-hold"
              ? (a.corporate_credit_settings?.credit_status ?? "on-hold") === "on-hold"
              : !a.corporate_contacts?.length)) &&
          (!term ||
            a.legal_name.toLowerCase().includes(term) ||
            (a.trading_name ?? "").toLowerCase().includes(term) ||
            (a.account_number ?? "").toLowerCase().includes(term) ||
            (a.email ?? "").toLowerCase().includes(term)),
      ),
    [accounts, typeRail, statusFilter, lens, term],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, AccountRow[]>();
    for (const row of filtered) {
      const key = titleCase(row.account_type);
      const bucket = map.get(key);
      if (bucket) bucket.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  const railItems = CORPORATE_TYPES.map((t) => ({
    id: t,
    label: titleCase(t),
    count: accounts.filter((a) => a.account_type === t).length,
  }));

  const activeFilters: ActiveFilterChip[] = [];
  if (statusFilter !== "all")
    activeFilters.push({
      id: "status",
      label: titleCase(statusFilter),
      onClear: () => setStatusFilter("all"),
    });
  if (lens !== "none")
    activeFilters.push({
      id: "lens",
      label: lens === "on-hold" ? "Credit on hold" : "No contacts",
      onClear: () => setLens("none"),
    });

  const clearAll = () => {
    setStatusFilter("all");
    setLens("none");
  };

  const inspected = filtered.find((a) => a.id === inspectId) ?? null;

  async function createAccount() {
    if (!profile?.organization_id || !form.legal_name.trim()) return;
    const { data: created, error } = await supabase
      .from("corporate_accounts")
      .insert({
        organization_id: profile.organization_id,
        branch_id: writeBranchId,
        account_number: referenceFor("CORP"),
        legal_name: form.legal_name.trim(),
        trading_name: form.trading_name.trim(),
        account_type: form.account_type,
        email: form.email.trim(),
        phone: form.phone.trim(),
        industry: form.industry.trim(),
        notes: form.notes.trim(),
        created_by: user?.id ?? null,
      })
      .select("id")
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    await supabase.from("corporate_credit_settings").insert({
      organization_id: profile.organization_id,
      corporate_account_id: created.id,
      credit_status: "on-hold",
      credit_limit: 0,
      created_by: user?.id ?? null,
    });
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.corporate.create",
      module: "crm-corporate",
      recordId: created.id,
      newValue: { legal_name: form.legal_name },
    });
    setForm({
      legal_name: "",
      trading_name: "",
      account_type: "company",
      email: "",
      phone: "",
      industry: "",
      notes: "",
    });
    setOpen(false);
    void refetch();
    invalidate();
    toast.success("Corporate account created with credit on hold");
  }

  async function addContact() {
    if (!profile?.organization_id || !contactFor || !contact.full_name.trim()) return;
    const { error } = await supabase.from("corporate_contacts").insert({
      organization_id: profile.organization_id,
      corporate_account_id: contactFor.id,
      full_name: contact.full_name.trim(),
      job_title: contact.job_title.trim(),
      email: contact.email.trim(),
      phone: contact.phone.trim(),
      is_primary: contact.is_primary,
      created_by: user?.id ?? null,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    setContact({ full_name: "", job_title: "", email: "", phone: "", is_primary: false });
    setContactFor(null);
    void refetch();
    toast.success("Contact added");
  }

  /** Credit limits are never set directly — they go through the Phase 2 Approval Centre. */
  async function requestCredit() {
    if (!profile?.organization_id || !creditFor) return;
    const amount = Number(credit.limit);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a valid credit limit");
      return;
    }
    const { data: request, error } = await supabase
      .from("approval_requests")
      .insert({
        organization_id: profile.organization_id,
        branch_id: writeBranchId,
        department_id: profile.department_id,
        reference: referenceFor("APR"),
        approval_type: "credit-account",
        requester_id: user?.id ?? "",
        reason: credit.reason || `Credit limit request for ${creditFor.legal_name}`,
        notes: `Requested limit ${amount}, payment terms ${credit.terms} days.`,
        amount,
        status: "pending_approval",
      })
      .select("id")
      .single();
    if (error) {
      toast.error(error.message);
      return;
    }
    await supabase
      .from("corporate_credit_settings")
      .update({ last_approval_request_id: request.id })
      .eq("corporate_account_id", creditFor.id);
    await supabase.from("notifications").insert({
      organization_id: profile.organization_id,
      category: "approval",
      title: "Credit approval request",
      body: `${profile.full_name} requested a credit limit for ${creditFor.legal_name}.`,
      priority: "high",
      link: "/approvals",
    });
    await logAudit({
      organizationId: profile.organization_id,
      userId: user?.id ?? null,
      userName: profile.full_name,
      action: "crm.credit.request",
      module: "crm-credit",
      recordId: creditFor.id,
      newValue: { amount, terms: credit.terms },
      reason: credit.reason,
    });
    setCredit({ limit: "", terms: "30", reason: "" });
    setCreditFor(null);
    toast.success("Credit request sent to the Approval Centre — self-approval is blocked there");
  }

  const leadFigure: SummaryFigure = {
    id: "total",
    label: "Corporate accounts",
    value: isLoading ? "…" : accounts.length,
  };
  const figures: SummaryFigure[] = [
    {
      id: "on-hold",
      label: "Credit on hold",
      value: isLoading ? "…" : onHoldCount,
      tone: onHoldCount ? "warning" : "success",
      onSelect: () => toggleLens("on-hold"),
      active: lens === "on-hold",
    },
    {
      id: "no-contacts",
      label: "No contacts",
      value: isLoading ? "…" : noContactsCount,
      tone: noContactsCount ? "info" : "success",
      onSelect: () => toggleLens("no-contacts"),
      active: lens === "no-contacts",
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Guest CRM"
        title="Corporate Accounts"
        description="Companies, government institutions, NGOs, schools, hospitals and travel partners. Credit limits require approval and are fully audited."
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-2 size-4" /> Add corporate account
            </Button>
          ) : null
        }
      />

      <SummaryStrip lead={leadFigure} figures={figures} />

      <CatalogueWorkspace
        rail={
          <CatalogueRail
            title="Account type"
            items={railItems}
            value={typeRail}
            onChange={setTypeRail}
            allLabel="All types"
            allCount={accounts.length}
          />
        }
      >
        <CatalogueQueryBar
          search={search}
          onSearch={setSearch}
          placeholder="Legal name, trading name, account number or email"
          activeFilters={activeFilters}
          onClearAll={activeFilters.length ? clearAll : undefined}
          filters={
            <div className="space-y-1.5">
              <Label>Account status</Label>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger aria-label="Filter by account status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          }
        />

        <QueryState
          isLoading={isLoading}
          error={null}
          isEmpty={accounts.length === 0}
          empty={
            <EmptyState
              icon={Building2}
              title="No corporate accounts yet"
              description="Create the first corporate account to manage contacts, credit and billing preferences."
            />
          }
        >
          {isLoading ? (
            <LoadingState variant="rows" rows={4} />
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No accounts match the current filters.
            </p>
          ) : (
            <div className="min-w-0">
              {grouped.map(([groupName, rows]) => (
                <CatalogueGroup key={groupName} label={groupName} count={rows.length}>
                  {rows.map((a) => (
                    <CatalogueRow
                      key={a.id}
                      selected={inspectId === a.id}
                      onOpen={() => setInspectId(a.id)}
                      media={
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                          <Building2 className="size-4" />
                        </span>
                      }
                      title={a.legal_name}
                      subtitle={[a.account_number, a.email || a.phone].filter(Boolean).join(" · ")}
                      chips={
                        <>
                          <StatusPill tone={a.account_status === "active" ? "success" : "default"}>
                            {titleCase(a.account_status)}
                          </StatusPill>
                          <StatusPill
                            tone={
                              (a.corporate_credit_settings?.credit_status ?? "on-hold") === "active"
                                ? "success"
                                : "warning"
                            }
                          >
                            {titleCase(a.corporate_credit_settings?.credit_status ?? "on-hold")}
                          </StatusPill>
                          {!a.corporate_contacts?.length ? (
                            <StatusPill tone="info">No contacts</StatusPill>
                          ) : null}
                        </>
                      }
                      trailing={`${a.corporate_contacts?.length ?? 0} contact${
                        a.corporate_contacts?.length === 1 ? "" : "s"
                      }`}
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
        title={inspected?.legal_name ?? ""}
        subtitle={
          inspected
            ? `${inspected.account_number} · ${titleCase(inspected.account_type)}`
            : undefined
        }
        media={
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Building2 className="size-5" />
          </span>
        }
        chips={
          inspected ? (
            <StatusPill tone={inspected.account_status === "active" ? "success" : "default"}>
              {titleCase(inspected.account_status)}
            </StatusPill>
          ) : null
        }
        footer={
          inspected ? (
            <>
              <Button
                variant="outline"
                onClick={() => setContactFor(inspected)}
                disabled={!canManage}
              >
                Add contact
              </Button>
              <Button onClick={() => setCreditFor(inspected)} disabled={!canRequestCredit}>
                Request credit limit
              </Button>
            </>
          ) : null
        }
      >
        {inspected ? (
          <>
            <InspectorSection title="Contact">
              <InspectorField label="Email">{inspected.email || "—"}</InspectorField>
              <InspectorField label="Phone">{inspected.phone || "—"}</InspectorField>
            </InspectorSection>
            <InspectorSection title="Credit">
              <InspectorField label="Status">
                {titleCase(inspected.corporate_credit_settings?.credit_status ?? "on-hold")}
              </InspectorField>
              <InspectorField label="Limit">
                {inspected.corporate_credit_settings?.credit_limit ?? 0}
              </InspectorField>
              <InspectorField label="Payment terms">
                {inspected.corporate_credit_settings?.payment_terms_days ?? 30} days
              </InspectorField>
              <InspectorField label="Statements">
                Outstanding balances appear here once the Finance module records invoices.
              </InspectorField>
            </InspectorSection>
            <InspectorSection title={`Contacts (${inspected.corporate_contacts?.length ?? 0})`}>
              {inspected.corporate_contacts?.length ? (
                <ul className="space-y-1.5 text-sm text-muted-foreground">
                  {inspected.corporate_contacts.map((c) => (
                    <li key={c.id}>
                      {c.full_name}
                      {c.job_title ? ` · ${c.job_title}` : ""}
                      {c.is_primary ? " · primary" : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No contacts recorded.</p>
              )}
            </InspectorSection>
          </>
        ) : null}
      </InspectorSheet>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              <span className="inline-flex items-center gap-2">
                <Building2 className="size-4" /> Add corporate account
              </span>
            </DialogTitle>
            <DialogDescription>
              New accounts start with credit on hold until a limit is approved.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Labeled label="Legal name">
              <Input
                value={form.legal_name}
                onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
              />
            </Labeled>
            <Labeled label="Trading name">
              <Input
                value={form.trading_name}
                onChange={(e) => setForm({ ...form, trading_name: e.target.value })}
              />
            </Labeled>
            <Labeled label="Account type">
              <Select
                value={form.account_type}
                onValueChange={(v) => setForm({ ...form, account_type: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CORPORATE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {titleCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Labeled>
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="Email">
                <Input
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </Labeled>
              <Labeled label="Phone">
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </Labeled>
            </div>
            <Labeled label="Industry">
              <Input
                value={form.industry}
                onChange={(e) => setForm({ ...form, industry: e.target.value })}
              />
            </Labeled>
            <Labeled label="Notes">
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </Labeled>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createAccount} disabled={!form.legal_name.trim()}>
              Create account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(contactFor)} onOpenChange={(o) => !o && setContactFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add contact</DialogTitle>
            <DialogDescription>{contactFor?.legal_name}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Labeled label="Full name">
              <Input
                value={contact.full_name}
                onChange={(e) => setContact({ ...contact, full_name: e.target.value })}
              />
            </Labeled>
            <Labeled label="Job title">
              <Input
                value={contact.job_title}
                onChange={(e) => setContact({ ...contact, job_title: e.target.value })}
              />
            </Labeled>
            <Labeled label="Email">
              <Input
                value={contact.email}
                onChange={(e) => setContact({ ...contact, email: e.target.value })}
              />
            </Labeled>
            <Labeled label="Phone">
              <Input
                value={contact.phone}
                onChange={(e) => setContact({ ...contact, phone: e.target.value })}
              />
            </Labeled>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={contact.is_primary}
                onChange={(e) => setContact({ ...contact, is_primary: e.target.checked })}
              />
              Primary contact
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setContactFor(null)}>
              Cancel
            </Button>
            <Button onClick={addContact} disabled={!contact.full_name.trim()}>
              Add contact
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(creditFor)} onOpenChange={(o) => !o && setCreditFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Request credit limit</DialogTitle>
            <DialogDescription>
              The request goes to the Approval Centre. You cannot approve your own request.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Labeled label="Requested limit">
              <Input
                type="number"
                value={credit.limit}
                onChange={(e) => setCredit({ ...credit, limit: e.target.value })}
              />
            </Labeled>
            <Labeled label="Payment terms (days)">
              <Input
                type="number"
                value={credit.terms}
                onChange={(e) => setCredit({ ...credit, terms: e.target.value })}
              />
            </Labeled>
            <Labeled label="Reason">
              <Textarea
                rows={2}
                value={credit.reason}
                onChange={(e) => setCredit({ ...credit, reason: e.target.value })}
              />
            </Labeled>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreditFor(null)}>
              Cancel
            </Button>
            <Button onClick={requestCredit}>Send for approval</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
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
    <OpsGuard path="/crm/corporate">
      <Page />
    </OpsGuard>
  );
}
