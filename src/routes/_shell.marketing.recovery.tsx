import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { LifeBuoy, Plus } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EmptyState, MetricTile } from "@/components/marketing/MarketingShared";
import {
  useCreateRecoveryCase,
  useCustomersLookup,
  useRecoveryCases,
  useUpdateRecoveryCase,
} from "@/lib/marketing-data";
import {
  COMPENSATION_TYPES,
  RECOVERY_SEVERITIES,
  compensationNeedsApproval,
  formatDateTime,
  titleCase,
} from "@/lib/marketing";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/marketing/recovery")({
  head: () => ({
    meta: [
      { title: "Service Recovery — Marketing & CRM" },
      {
        name: "description",
        content:
          "Track dissatisfied guests through acknowledgement, resolution and approved compensation.",
      },
      { property: "og:title", content: "Service Recovery — Marketing & CRM" },
      {
        property: "og:description",
        content: "Service recovery cases with approval-gated compensation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type Row = Record<string, any>;

function Page() {
  const { can } = useAuth();
  const [openOnly, setOpenOnly] = useState(true);
  const { data: cases } = useRecoveryCases(openOnly);
  const update = useUpdateRecoveryCase();
  const [open, setOpen] = useState(false);

  const rows = (cases ?? []) as Row[];
  const critical = rows.filter((c) => String(c["severity"]) === "critical").length;
  const awaiting = rows.filter(
    (c) => String(c["compensation_status"] ?? "") === "pending_approval",
  ).length;

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Service Recovery"
        description="Complaints and low-rated feedback become recovery cases with an owner and a deadline. Compensation above the configured threshold requires approval before it is issued."
        actions={
          can("marketing", "create") ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-1.5 size-4" /> Open case
            </Button>
          ) : null
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <MetricTile label="Cases listed" value={String(rows.length)} />
        <MetricTile
          label="Critical"
          value={String(critical)}
          tone={critical ? "destructive" : "default"}
        />
        <MetricTile
          label="Compensation awaiting approval"
          value={String(awaiting)}
          tone={awaiting ? "warning" : "default"}
        />
      </div>

      <div className="mb-4 flex items-center gap-2">
        <Switch id="open" checked={openOnly} onCheckedChange={setOpenOnly} />
        <Label htmlFor="open" className="text-sm">
          Show open cases only
        </Label>
      </div>

      <SectionCard title="Recovery cases">
        {!rows.length ? (
          <EmptyState
            icon={LifeBuoy}
            title="No recovery cases"
            description="Cases are opened from complaints, low ratings or negative reviews."
          />
        ) : (
          <ul className="space-y-3">
            {rows.map((c) => (
              <li key={String(c["id"])} className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-medium text-foreground">
                      {String(c["case_number"])} · {c["customers"]?.full_name ?? "Guest"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Opened {formatDateTime(c["created_at"])} · Severity{" "}
                      {titleCase(String(c["severity"]))}
                    </p>
                  </div>
                  <StatusPill
                    tone={
                      String(c["status"]) === "resolved"
                        ? "success"
                        : String(c["severity"]) === "critical"
                          ? "destructive"
                          : "warning"
                    }
                  >
                    {titleCase(String(c["status"]))}
                  </StatusPill>
                </div>
                {c["summary"] ? (
                  <p className="mt-2 text-sm text-muted-foreground">{String(c["summary"])}</p>
                ) : null}
                {c["compensation_type"] ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Proposed compensation: {titleCase(String(c["compensation_type"]))} ·{" "}
                    {Number(c["compensation_value"] ?? 0).toLocaleString()} ·{" "}
                    {titleCase(String(c["compensation_status"] ?? "draft"))}
                  </p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {String(c["status"]) !== "resolved" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        update.mutate({
                          id: String(c["id"]),
                          patch: { status: "resolved", resolved_at: new Date().toISOString() },
                        })
                      }
                    >
                      Mark resolved
                    </Button>
                  ) : null}
                  {can("marketing", "approve") &&
                  String(c["compensation_status"] ?? "") === "pending_approval" ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          update.mutate({
                            id: String(c["id"]),
                            patch: { compensation_status: "approved" },
                          })
                        }
                      >
                        Approve compensation
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          update.mutate({
                            id: String(c["id"]),
                            patch: { compensation_status: "rejected" },
                            reason: "Compensation declined on review",
                          })
                        }
                      >
                        Decline
                      </Button>
                    </>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <CaseDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function CaseDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const create = useCreateRecoveryCase();
  const [search, setSearch] = useState("");
  const { data: customers } = useCustomersLookup(search);
  const [form, setForm] = useState<Row>({
    severity: "medium",
    status: "open",
    compensation_type: "none",
  });
  const set = (k: string, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  const needsApproval = compensationNeedsApproval(
    String(form["compensation_type"] ?? "none"),
    Number(form["compensation_value"] ?? 0),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Open recovery case</DialogTitle>
          <DialogDescription>
            Link the case to the guest so the outcome joins their unified profile.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Customer</Label>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search customers"
            />
            <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
              {((customers ?? []) as Row[]).map((c) => (
                <button
                  key={String(c["id"])}
                  type="button"
                  onClick={() => set("customer_id", String(c["id"]))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-left text-sm ${
                    form["customer_id"] === String(c["id"])
                      ? "border-primary bg-primary/5"
                      : "border-border"
                  }`}
                >
                  {String(c["full_name"])}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label>Severity</Label>
            <Select value={String(form["severity"])} onValueChange={(v) => set("severity", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECOVERY_SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {titleCase(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Summary</Label>
            <Textarea
              rows={3}
              value={String(form["summary"] ?? "")}
              onChange={(e) => set("summary", e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Compensation type</Label>
              <Select
                value={String(form["compensation_type"])}
                onValueChange={(v) => set("compensation_type", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMPENSATION_TYPES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {titleCase(c)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Value</Label>
              <Input
                type="number"
                min={0}
                onChange={(e) => set("compensation_value", Number(e.target.value || 0))}
              />
            </div>
          </div>
          {needsApproval ? (
            <p className="text-xs text-on-tint-warning">
              This compensation exceeds the automatic threshold and will be created as pending
              approval.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!form["customer_id"] || create.isPending}
            onClick={() =>
              create.mutate(
                {
                  ...form,
                  compensation_status: needsApproval ? "pending_approval" : "not_required",
                },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Open case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/recovery">
      <Page />
    </OpsGuard>
  );
}
