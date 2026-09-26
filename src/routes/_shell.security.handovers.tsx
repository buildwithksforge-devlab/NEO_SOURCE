import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import {
  EmptyState,
  QueryState,
  SecurityGuard,
  SecurityStatusBadge,
} from "@/components/security/SecurityShared";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { titleCase } from "@/lib/kitchen";
import {
  SHIFT_LABELS,
  securityNum,
  securityStr,
  useAcknowledgeHandover,
  useSecurityHandovers,
  useSecurityPosts,
  useSecurityStaff,
  useSubmitHandover,
  type SecurityRow,
} from "@/lib/security-department";

export const Route = createFileRoute("/_shell/security/handovers")({
  head: () => ({
    meta: [
      { title: "Security Shift Handovers — NEØ" },
      {
        name: "description",
        content:
          "Record what the outgoing shift is passing on — open incidents, vehicles on site, equipment — and have the incoming guard acknowledge it.",
      },
      { property: "og:title", content: "Security Shift Handovers — NEØ" },
      {
        property: "og:description",
        content: "Shift handover notes and acknowledgements for the Security department.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <SecurityGuard feature="handovers">
      <HandoversPage />
    </SecurityGuard>
  ),
});

function HandoversPage() {
  const handovers = useSecurityHandovers();
  const posts = useSecurityPosts();
  const staff = useSecurityStaff();
  const submit = useSubmitHandover();
  const acknowledge = useAcknowledgeHandover();

  const [open, setOpen] = useState(false);
  const [postId, setPostId] = useState("none");
  const [shiftLabel, setShiftLabel] = useState<string>("day");
  const [incomingId, setIncomingId] = useState("none");
  const [openIncidents, setOpenIncidents] = useState("0");
  const [vehicles, setVehicles] = useState("0");
  const [equipment, setEquipment] = useState("");
  const [notes, setNotes] = useState("");

  const rows = (handovers.data ?? []) as SecurityRow[];
  const staffRows = (staff.data ?? []) as SecurityRow[];

  function save() {
    submit.mutate(
      {
        postId: postId === "none" ? null : postId,
        incomingId: incomingId === "none" ? null : incomingId,
        shiftLabel,
        openIncidents: Number(openIncidents) || 0,
        vehicles: Number(vehicles) || 0,
        ...(equipment ? { equipment } : {}),
        ...(notes ? { notes } : {}),
      },
      {
        onSuccess: () => {
          setOpen(false);
          setEquipment("");
          setNotes("");
          setOpenIncidents("0");
          setVehicles("0");
        },
      },
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Security"
        title="Shift handovers"
        description="Nothing is passed on by word of mouth. The outgoing guard records the state of the post and the incoming guard acknowledges it."
        actions={<Button onClick={() => setOpen(true)}>Record handover</Button>}
      />

      <SectionCard title="Handover log" description="Newest handover first.">
        <QueryState
          isLoading={handovers.isLoading}
          error={handovers.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No handovers"
              description="No shift handover has been recorded yet."
            />
          }
        >
          <div className="space-y-3">
            {rows.map((r) => {
              const acknowledged = Boolean(r["acknowledged_at"]);
              return (
                <div key={String(r["id"])} className="rounded-lg border border-border/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">
                        {titleCase(securityStr(r["shift_label"], "day"))} shift ·{" "}
                        {new Date(String(r["created_at"])).toLocaleString()}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {securityNum(r["open_incidents"])} open incidents ·{" "}
                        {securityNum(r["vehicles_on_site"])} vehicles on site
                      </p>
                    </div>
                    {acknowledged ? (
                      <StatusPill tone="success">Acknowledged</StatusPill>
                    ) : (
                      <div className="flex items-center gap-2">
                        <SecurityStatusBadge status={securityStr(r["status"], "submitted")} />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={acknowledge.isPending}
                          onClick={() => acknowledge.mutate(String(r["id"]))}
                        >
                          Acknowledge
                        </Button>
                      </div>
                    )}
                  </div>
                  {r["equipment_notes"] ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Equipment: {securityStr(r["equipment_notes"])}
                    </p>
                  ) : null}
                  {r["notes"] ? <p className="mt-2 text-sm">{securityStr(r["notes"])}</p> : null}
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record a shift handover</DialogTitle>
            <DialogDescription>
              Pass on the true state of the post to the incoming guard.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>Post</Label>
              <Select value={postId} onValueChange={setPostId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific post</SelectItem>
                  {((posts.data ?? []) as SecurityRow[]).map((p) => (
                    <SelectItem key={String(p["id"])} value={String(p["id"])}>
                      {securityStr(p["name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Shift</Label>
              <Select value={shiftLabel} onValueChange={setShiftLabel}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SHIFT_LABELS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Incoming guard</Label>
              <Select value={incomingId} onValueChange={setIncomingId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not yet known</SelectItem>
                  {staffRows.map((s) => (
                    <SelectItem key={String(s["id"])} value={String(s["id"])}>
                      {securityStr(s["full_name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="handover-incidents">Open incidents</Label>
                <Input
                  id="handover-incidents"
                  type="number"
                  min={0}
                  value={openIncidents}
                  onChange={(e) => setOpenIncidents(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="handover-vehicles">Vehicles on site</Label>
                <Input
                  id="handover-vehicles"
                  type="number"
                  min={0}
                  value={vehicles}
                  onChange={(e) => setVehicles(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="handover-equipment">Equipment handed over</Label>
              <Textarea
                id="handover-equipment"
                value={equipment}
                onChange={(e) => setEquipment(e.target.value)}
                rows={2}
                placeholder="Radio, torch, keys, register…"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="handover-notes">Notes for the incoming shift</Label>
              <Textarea
                id="handover-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={submit.isPending}>
              Record handover
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
