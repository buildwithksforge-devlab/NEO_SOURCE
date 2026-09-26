import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { LifeBuoy, Plus } from "lucide-react";
import { SectionCard, StatCard } from "@/components/common/DataDisplay";
import {
  AccessDenied,
  EmptyState,
  TonePill,
  TruthNotice,
  formatDateTime,
  humanise,
  statusTone,
} from "@/components/platform/PlatformShared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import {
  useAddTicketMessage,
  useCreateTicket,
  useKnowledgeArticles,
  useSupportAccessGrants,
  useSupportPlans,
  useSupportTickets,
  useTicketMessages,
} from "@/lib/platform-data";
import { slaState } from "@/lib/platform";

export const Route = createFileRoute("/_shell/platform/support")({
  component: SupportScreen,
});

const MODULES = [
  "front-office",
  "restaurant",
  "kitchen",
  "housekeeping",
  "inventory",
  "finance",
  "events",
  "hr",
  "delivery",
  "administration",
];
const SEVERITIES = ["critical", "high", "medium", "low"];

function SupportScreen() {
  const { can, isAdmin } = useAuth();
  const tickets = useSupportTickets();
  const plans = useSupportPlans();
  const grants = useSupportAccessGrants();
  const articles = useKnowledgeArticles();
  const create = useCreateTicket();
  const addMessage = useAddTicketMessage();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const messages = useTicketMessages(selected);

  if (!isAdmin && !can("support", "view") && !can("support", "create")) {
    return (
      <AccessDenied
        title="Support workspace is restricted"
        body="Ask an administrator to grant the support module to your role so you can raise and follow up tickets."
      />
    );
  }

  const list = tickets.data ?? [];
  const openTickets = list.filter((t) => !["resolved", "closed"].includes(String(t["status"])));
  const planFor = (code: unknown) => (plans.data ?? []).find((p) => p["code"] === code);
  const activeGrants = (grants.data ?? []).filter(
    (g) => !g["revoked_at"] && new Date(String(g["expires_at"])) > new Date(),
  );

  return (
    <div className="space-y-6">
      <TruthNotice>
        Support staff cannot enter your data without a time-limited, reason-stamped access grant
        that you approve, and every such access is recorded in the audit trail.
      </TruthNotice>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open tickets" value={String(openTickets.length)} />
        <StatCard label="Total tickets" value={String(list.length)} />
        <StatCard label="Active support access grants" value={String(activeGrants.length)} />
        <StatCard label="Help articles" value={String((articles.data ?? []).length)} />
      </div>

      <SectionCard
        title="Support tickets"
        description="Raise an issue with the module, severity and reproduction detail so it can be triaged against your service level."
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus className="mr-2 size-4" />
            Raise ticket
          </Button>
        }
      >
        {list.length === 0 ? (
          <EmptyState
            title="No support tickets"
            body="Tickets you raise appear here with their service-level status."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Response target</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((t) => {
                  const plan = planFor(t["support_plan_code"]);
                  const sla = slaState(
                    String(t["created_at"]),
                    t["first_response_at"] as string | null,
                    plan?.["first_response_minutes"] as number | undefined,
                  );
                  const id = String(t["id"]);
                  return (
                    <TableRow key={id} className={selected === id ? "bg-muted/40" : undefined}>
                      <TableCell className="font-mono text-xs">{String(t["reference"])}</TableCell>
                      <TableCell className="max-w-sm truncate">{String(t["subject"])}</TableCell>
                      <TableCell>
                        <TonePill tone={statusTone(String(t["severity"]))}>
                          {humanise(String(t["severity"]))}
                        </TonePill>
                      </TableCell>
                      <TableCell>
                        <TonePill tone={statusTone(String(t["status"]))}>
                          {humanise(String(t["status"]))}
                        </TonePill>
                      </TableCell>
                      <TableCell>
                        <TonePill tone={sla.tone}>{sla.label}</TonePill>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setSelected(selected === id ? null : id)}
                        >
                          {selected === id ? "Close" : "Open"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {selected ? (
          <div className="mt-4 space-y-3 rounded-lg border border-border p-3">
            <p className="flex items-center gap-2 text-sm font-medium text-foreground">
              <LifeBuoy className="size-4" /> Conversation
            </p>
            {(messages.data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No replies yet.</p>
            ) : (
              <ul className="space-y-2">
                {(messages.data ?? []).map((m) => (
                  <li key={String(m["id"])} className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                    <p className="text-foreground">{String(m["body"])}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDateTime(m["created_at"] as string)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Textarea
                rows={2}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Add a reply"
              />
              <Button
                disabled={!reply.trim()}
                onClick={() =>
                  addMessage.mutate(
                    { ticket_id: selected, body: reply },
                    { onSuccess: () => setReply("") },
                  )
                }
              >
                Send
              </Button>
            </div>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Knowledge base"
        description="Role-based guides, troubleshooting and reference material."
      >
        {(articles.data ?? []).length === 0 ? (
          <EmptyState
            title="No help articles published"
            body="Published guidance will appear here for your team."
          />
        ) : (
          <ul className="space-y-2 text-sm">
            {(articles.data ?? []).map((a) => (
              <li key={String(a["id"])} className="rounded-lg border border-border px-3 py-2">
                <p className="font-medium text-foreground">{String(a["title"])}</p>
                <p className="text-xs text-muted-foreground">{String(a["summary"] ?? "")}</p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <TicketDialog
        open={open}
        onClose={() => setOpen(false)}
        onSave={(v) => create.mutate(v, { onSuccess: () => setOpen(false) })}
      />
    </div>
  );
}

function TicketDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onSave: (values: Record<string, unknown>) => void;
}) {
  const [subject, setSubject] = useState("");
  const [module, setModule] = useState("front-office");
  const [severity, setSeverity] = useState("medium");
  const [description, setDescription] = useState("");
  const [consent, setConsent] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Raise a support ticket</DialogTitle>
          <DialogDescription>
            Describe what happened, what you expected, and how many people are affected.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Module</Label>
              <Select value={module} onValueChange={setModule}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODULES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {humanise(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Severity</Label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {humanise(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
            <span className="text-sm text-foreground">
              Allow support to inspect this property's data for this ticket
            </span>
            <Switch checked={consent} onCheckedChange={setConsent} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!subject.trim() || !description.trim()}
              onClick={() =>
                onSave({
                  subject,
                  module,
                  severity,
                  description,
                  inspection_consent: consent,
                  status: "new",
                })
              }
            >
              Raise ticket
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
