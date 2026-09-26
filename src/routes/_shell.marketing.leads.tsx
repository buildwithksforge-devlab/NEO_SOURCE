import { useMemo, useState } from "react";
import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Search, Users } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
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
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/marketing/MarketingShared";
import {
  useAssignableStaff,
  useCreateLead,
  useLeadActivities,
  useLeadSources,
  useLeadStageHistory,
  useLeads,
  useMoveLeadStage,
  useRecordFollowUp,
  useAssignLead,
  useConvertLeadToCustomer,
  useCustomersLookup,
} from "@/lib/marketing-data";
import {
  LEAD_ACTIVITY_TYPES,
  LEAD_STAGES,
  LEAD_TYPES,
  formatDate,
  formatDateTime,
  isOverdue,
  leadStageLabels,
  leadStageTone,
  titleCase,
} from "@/lib/marketing";
import { useAuth } from "@/lib/auth";
import { NeoDatePicker } from "@/components/common/DatePicker";

export const Route = createFileRoute("/_shell/marketing/leads")({
  head: () => ({
    meta: [
      { title: "Leads — Marketing & CRM" },
      {
        name: "description",
        content:
          "Capture, assign and follow up enquiries from the website, telephone, walk-ins and campaigns.",
      },
      { property: "og:title", content: "Leads — Marketing & CRM" },
      { property: "og:description", content: "Lead capture, assignment and follow-up tracking." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<Row | null>(null);

  const filters = useMemo(
    () => ({ ...(search ? { search } : {}), ...(stage === "all" ? {} : { stage }) }),
    [search, stage],
  );
  const { data: leads, isLoading } = useLeads(filters);

  const canCreate = can("marketing", "create");

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Leads"
        description="Every enquiry captured from the website, telephone, WhatsApp, walk-ins, referrals or campaigns. Converting a lead links to the existing reservation, event or customer record rather than creating a duplicate."
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 size-4" /> New lead
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search name, company, email or lead number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={stage} onValueChange={setStage}>
          <SelectTrigger className="w-56">
            <SelectValue placeholder="All stages" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stages</SelectItem>
            {LEAD_STAGES.map((s) => (
              <SelectItem key={s} value={s}>
                {leadStageLabels[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SectionCard title="Lead register" description="Ordered by most recently captured.">
        {isLoading ? (
          <LoadingState variant="rows" rows={6} />
        ) : !leads?.length ? (
          <EmptyState
            icon={Users}
            title="No leads recorded yet"
            description="Leads appear here once captured from a website form or entered by staff. Nothing is pre-populated."
            action={
              canCreate ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  Capture the first lead
                </Button>
              ) : null
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Follow-up</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(leads as Row[]).map((lead) => (
                  <TableRow
                    key={String(lead["id"])}
                    className="cursor-pointer"
                    onClick={() => setSelected(lead)}
                  >
                    <TableCell className="font-medium">{String(lead["lead_number"])}</TableCell>
                    <TableCell>
                      <p className="font-medium text-foreground">{String(lead["contact_name"])}</p>
                      {lead["company"] ? (
                        <p className="text-xs text-muted-foreground">{String(lead["company"])}</p>
                      ) : null}
                    </TableCell>
                    <TableCell>{titleCase(String(lead["lead_type"]))}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {lead["lead_sources"]?.name ?? lead["source_label"] ?? "—"}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={leadStageTone(String(lead["stage"]))}>
                        {leadStageLabels[String(lead["stage"]) as keyof typeof leadStageLabels]}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {Number(lead["estimated_value"] ?? 0).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-sm">
                      {isOverdue(lead["next_followup_at"], String(lead["stage"])) ? (
                        <StatusPill tone="destructive">
                          Overdue · {formatDate(lead["next_followup_at"])}
                        </StatusPill>
                      ) : (
                        formatDate(lead["next_followup_at"])
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <CreateLeadDialog open={createOpen} onOpenChange={setCreateOpen} />
      <LeadDrawer lead={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function CreateLeadDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const create = useCreateLead();
  const { data: sources } = useLeadSources();
  const [form, setForm] = useState<Row>({
    lead_type: "accommodation",
    preferred_channel: "phone",
    stage: "new",
  });

  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Capture lead</DialogTitle>
          <DialogDescription>
            Record the enquiry only. Consent for marketing messages is captured separately in the
            consent register.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="lead-contact-name">Contact name</Label>
            <Input
              id="lead-contact-name"
              value={String(form["contact_name"] ?? "")}
              onChange={(e) => set("contact_name", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="lead-company">Company</Label>
            <Input
              id="lead-company"
              value={String(form["company"] ?? "")}
              onChange={(e) => set("company", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="lead-type">Lead type</Label>
            <Select value={String(form["lead_type"])} onValueChange={(v) => set("lead_type", v)}>
              <SelectTrigger id="lead-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAD_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {titleCase(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="lead-phone">Phone</Label>
            <Input
              id="lead-phone"
              value={String(form["phone"] ?? "")}
              onChange={(e) => set("phone", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="lead-email">Email</Label>
            <Input
              id="lead-email"
              type="email"
              value={String(form["email"] ?? "")}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="lead-channel">Preferred channel</Label>
            <Select
              value={String(form["preferred_channel"])}
              onValueChange={(v) => set("preferred_channel", v)}
            >
              <SelectTrigger id="lead-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["phone", "email", "whatsapp", "sms", "in_person"].map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="lead-source">Source</Label>
            <Select
              value={String(form["source_id"] ?? "")}
              onValueChange={(v) => set("source_id", v)}
            >
              <SelectTrigger id="lead-source">
                <SelectValue placeholder="Select a recorded source" />
              </SelectTrigger>
              <SelectContent>
                {(sources ?? []).map((s: Row) => (
                  <SelectItem key={String(s["id"])} value={String(s["id"])}>
                    {String(s["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="lead-expected-start">Expected start</Label>
            <NeoDatePicker
              id="lead-expected-start"
              value={String(form["expected_start"] ?? "")}
              onChange={(v) => set("expected_start", v || null)}
            />
          </div>
          <div>
            <Label htmlFor="lead-guest-count">Guest count</Label>
            <Input
              id="lead-guest-count"
              type="number"
              min={0}
              value={String(form["guest_count"] ?? "")}
              onChange={(e) => set("guest_count", e.target.value ? Number(e.target.value) : null)}
            />
          </div>
          <div>
            <Label htmlFor="lead-estimated-value">Estimated value</Label>
            <Input
              id="lead-estimated-value"
              type="number"
              min={0}
              step="0.01"
              value={String(form["estimated_value"] ?? "")}
              onChange={(e) => set("estimated_value", Number(e.target.value || 0))}
            />
          </div>
          <div>
            <Label htmlFor="lead-followup">Follow-up due</Label>
            <Input
              id="lead-followup"
              type="datetime-local"
              value={String(form["next_followup_at"] ?? "")}
              onChange={(e) =>
                set(
                  "next_followup_at",
                  e.target.value ? new Date(e.target.value).toISOString() : null,
                )
              }
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="lead-requirements">Requirements</Label>
            <Textarea
              id="lead-requirements"
              rows={3}
              value={String(form["requirements"] ?? "")}
              onChange={(e) => set("requirements", e.target.value)}
            />
          </div>
        </div>


        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!form["contact_name"] || create.isPending}
            onClick={() =>
              create.mutate(form, {
                onSuccess: () => {
                  setForm({ lead_type: "accommodation", preferred_channel: "phone", stage: "new" });
                  onOpenChange(false);
                },
              })
            }
          >
            {create.isPending ? "Saving…" : "Create lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LeadDrawer({ lead, onClose }: { lead: Row | null; onClose: () => void }) {
  const id = lead ? String(lead["id"]) : undefined;
  const { data: activities } = useLeadActivities(id);
  const { data: history } = useLeadStageHistory(id);
  const { data: staff } = useAssignableStaff();
  const move = useMoveLeadStage();
  const assign = useAssignLead();
  const followUp = useRecordFollowUp();
  const convert = useConvertLeadToCustomer();
  const [customerSearch, setCustomerSearch] = useState("");
  const { data: customerMatches } = useCustomersLookup(customerSearch);
  const [note, setNote] = useState("");
  const [type, setType] = useState<string>("call");
  const [due, setDue] = useState("");

  if (!lead) return null;

  return (
    <Sheet open={Boolean(lead)} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>
            {String(lead["lead_number"])} · {String(lead["contact_name"])}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-10">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <Field label="Type" value={titleCase(String(lead["lead_type"]))} />
            <Field
              label="Stage"
              value={leadStageLabels[String(lead["stage"]) as keyof typeof leadStageLabels]}
            />
            <Field label="Phone" value={String(lead["phone"] ?? "—")} />
            <Field label="Email" value={String(lead["email"] ?? "—")} />
            <Field
              label="Estimated value"
              value={Number(lead["estimated_value"] ?? 0).toLocaleString()}
            />
            <Field label="Probability" value={`${Number(lead["probability"] ?? 0)}%`} />
            <Field label="Follow-up" value={formatDateTime(lead["next_followup_at"])} />
            <Field label="Consent" value={titleCase(String(lead["consent_status"] ?? "unknown"))} />
          </div>

          {lead["requirements"] ? (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Requirements
              </p>
              <p className="mt-1 text-sm text-foreground">{String(lead["requirements"])}</p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label>Move stage</Label>
            <Select
              value={String(lead["stage"])}
              onValueChange={(v) =>
                move.mutate({
                  id: String(lead["id"]),
                  fromStage: String(lead["stage"]),
                  toStage: v,
                })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAD_STAGES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {leadStageLabels[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <Label htmlFor="lead-customer-search">Customer record</Label>
            {lead["customer_id"] ? (
              <p className="text-sm text-foreground">
                This enquiry is linked to a customer record — billing and history go there.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Converting links this enquiry to a customer. An existing record is matched on
                  phone or email so nobody is entered twice.
                </p>
                <Input
                  id="lead-customer-search"
                  placeholder="Search existing customers"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                />
                {(customerMatches ?? []).length ? (
                  <div className="space-y-1">
                    {(customerMatches ?? []).map((c: Row) => (
                      <Button
                        key={String(c["id"])}
                        variant="outline"
                        size="sm"
                        className="w-full justify-start"
                        disabled={convert.isPending}
                        onClick={() => convert.mutate({ lead, customerId: String(c["id"]) })}
                      >
                        Link to {String(c["full_name"])} · {String(c["customer_number"])}
                      </Button>
                    ))}
                  </div>
                ) : null}
                <Button
                  size="sm"
                  disabled={convert.isPending}
                  onClick={() => convert.mutate({ lead })}
                >
                  Convert to customer
                </Button>
              </>
            )}
          </div>



          <div className="space-y-2">
            <Label>Assign to</Label>
            <Select
              value={String(lead["assigned_to"] ?? "")}
              onValueChange={(v) => assign.mutate({ id: String(lead["id"]), assignee: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                {(staff ?? []).map((s: Row) => (
                  <SelectItem key={String(s["id"])} value={String(s["id"])}>
                    {String(s["full_name"] ?? "Staff member")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">Only active staff accounts are listed.</p>
          </div>

          <div className="space-y-2 rounded-lg border border-border p-3">
            <Label>Record follow-up</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select value={type} onValueChange={setType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEAD_ACTIVITY_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {titleCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            <Textarea
              rows={2}
              placeholder="Outcome or notes"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!note || followUp.isPending}
              onClick={() =>
                followUp.mutate(
                  {
                    lead_id: String(lead["id"]),
                    activity_type: type,
                    notes: note,
                    due_at: due ? new Date(due).toISOString() : null,
                    status: due ? "planned" : "completed",
                    completed_at: due ? null : new Date().toISOString(),
                  },
                  {
                    onSuccess: () => {
                      setNote("");
                      setDue("");
                    },
                  },
                )
              }
            >
              Save follow-up
            </Button>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Follow-up timeline
            </p>
            {!activities?.length ? (
              <p className="text-sm text-muted-foreground">No follow-ups recorded.</p>
            ) : (
              <ul className="space-y-2">
                {(activities as Row[]).map((a) => (
                  <li
                    key={String(a["id"])}
                    className="rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{titleCase(String(a["activity_type"]))}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(a["created_at"])}
                      </span>
                    </div>
                    {a["notes"] ? (
                      <p className="mt-1 text-muted-foreground">{String(a["notes"])}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Stage history
            </p>
            {!history?.length ? (
              <p className="text-sm text-muted-foreground">No stage changes recorded.</p>
            ) : (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {(history as Row[]).map((h) => (
                  <li key={String(h["id"])}>
                    {formatDateTime(h["created_at"])} —{" "}
                    {titleCase(String(h["from_stage"] ?? "created"))} →{" "}
                    {titleCase(String(h["to_stage"]))}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm text-foreground">{value}</p>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/leads">
      <Page />
    </OpsGuard>
  );
}
