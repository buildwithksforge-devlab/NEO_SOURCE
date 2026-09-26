import { useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute } from "@tanstack/react-router";
import { BellOff, Plus } from "lucide-react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/marketing/MarketingShared";
import {
  useAddSuppression,
  useCustomersLookup,
  useLiftSuppression,
  useSuppressions,
} from "@/lib/marketing-data";
import {
  CONSENT_CHANNELS,
  SUPPRESSION_REASONS,
  formatDateTime,
  suppressionReasonLabels,
  titleCase,
} from "@/lib/marketing";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_shell/marketing/suppression")({
  head: () => ({
    meta: [
      { title: "Suppression Lists — Marketing & CRM" },
      {
        name: "description",
        content:
          "Hard bounces, complaints, unsubscribes and legal requests that permanently block marketing sends.",
      },
      { property: "og:title", content: "Suppression Lists — Marketing & CRM" },
      {
        property: "og:description",
        content: "Channel-level suppression enforced before any marketing send.",
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
  const [activeOnly, setActiveOnly] = useState(true);
  const { data: entries } = useSuppressions(activeOnly);
  const lift = useLiftSuppression();
  const [open, setOpen] = useState(false);

  return (
    <div>
      <PageHeader
        eyebrow="Marketing & CRM"
        title="Suppression Lists"
        description="Suppression always wins over consent and over any campaign audience. Entries are enforced server-side when the audience is frozen, so a suppressed contact can never be queued."
        actions={
          can("marketing", "create") ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-1.5 size-4" /> Add suppression
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex items-center gap-2">
        <Switch id="active" checked={activeOnly} onCheckedChange={setActiveOnly} />
        <Label htmlFor="active" className="text-sm">
          Show active entries only
        </Label>
      </div>

      <SectionCard title="Suppressed contacts">
        {!entries?.length ? (
          <EmptyState
            icon={BellOff}
            title="No suppression entries"
            description="Unsubscribes, complaints, hard bounces and legal requests will be listed here automatically."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Recorded</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(entries as Row[]).map((e) => (
                  <TableRow key={String(e["id"])}>
                    <TableCell>
                      {e["customers"]?.full_name ??
                        String(e["contact_value"] ?? e["customer_id"] ?? "—")}
                    </TableCell>
                    <TableCell>{titleCase(String(e["channel"]))}</TableCell>
                    <TableCell>
                      {suppressionReasonLabels[String(e["reason"])] ??
                        titleCase(String(e["reason"]))}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDateTime(e["created_at"])}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={e["active"] === false ? "default" : "destructive"}>
                        {e["active"] === false ? "Lifted" : "Suppressed"}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      {e["active"] !== false && can("marketing", "override") ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            lift.mutate({
                              id: String(e["id"]),
                              reason: "Lifted after documented customer request",
                            })
                          }
                        >
                          Lift
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Lifting a suppression is a privileged, audited action and should only follow a documented
          request from the customer. Complaints and legal requests should never be lifted.
        </p>
      </SectionCard>

      <AddDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function AddDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const add = useAddSuppression();
  const [search, setSearch] = useState("");
  const { data: customers } = useCustomersLookup(search);
  const [customerId, setCustomerId] = useState("");
  const [channel, setChannel] = useState<string>("email");
  const [reason, setReason] = useState<string>("unsubscribed");
  const [notes, setNotes] = useState("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add suppression</DialogTitle>
          <DialogDescription>
            Blocks all marketing on the selected channel. Transactional messages are unaffected.
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
                  onClick={() => setCustomerId(String(c["id"]))}
                  className={`w-full rounded-lg border px-3 py-1.5 text-left text-sm ${
                    customerId === String(c["id"]) ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  {String(c["full_name"])}
                </button>
              ))}
            </div>
          </div>
          <div>
            <Label>Channel</Label>
            <Select value={channel} onValueChange={setChannel}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONSENT_CHANNELS.map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SUPPRESSION_REASONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {suppressionReasonLabels[r] ?? titleCase(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!customerId || add.isPending}
            onClick={() =>
              add.mutate(
                { customer_id: customerId, channel, reason, notes, source: "staff_recorded" },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/marketing/suppression">
      <Page />
    </OpsGuard>
  );
}
