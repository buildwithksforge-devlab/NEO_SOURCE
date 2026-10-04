import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ConciergeBell } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PmsGuard, QueryState } from "@/components/pms/PmsShared";
import { GUEST_REQUEST_STATUSES, titleCase } from "@/lib/pms";
import { useAuth } from "@/lib/auth";
import { useGuestRequests, useUpdateGuestRequestStatus } from "@/lib/pms-data";
import {
  useAssignRequest,
  useAssignableStaff,
  useCompleteRequest,
  useDepartmentsLite,
  useRequestFeedback,
} from "@/lib/frontdesk-ops";
import { useChargeRequestToFolio } from "@/lib/request-charges";

export const Route = createFileRoute("/_shell/pms/requests")({
  head: () => ({
    meta: [
      { title: "Guest Requests — NEØ" },
      {
        name: "description",
        content:
          "Guest requests with department routing, assignment, escalation, completion evidence and guest feedback.",
      },
      { property: "og:title", content: "Guest Requests — NEØ" },
      {
        property: "og:description",
        content:
          "Guest requests with department routing, assignment, escalation, completion evidence and guest feedback.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="requests.view">
      <RequestsPage />
    </PmsGuard>
  ),
});

function dueTone(due: string | null, status: string) {
  if (!due || status === "completed" || status === "cancelled") return "default" as const;
  return new Date(due).getTime() < Date.now() ? ("destructive" as const) : ("info" as const);
}

function RequestsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState("new");
  const requests = useGuestRequests(status);
  const update = useUpdateGuestRequestStatus();
  const rows = requests.data ?? [];
  const mayEdit = can("pms", "requests.edit");
  const [assigning, setAssigning] = useState<string | null>(null);
  const [completing, setCompleting] = useState<string | null>(null);
  const [rating, setRating] = useState<string | null>(null);
  const [charging, setCharging] = useState<string | null>(null);

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Guest Requests"
        description="Requests raised at the desk, in the room or through the guest portal — routed to a department, owned by a worker, escalated when overdue and closed with evidence."
        actions={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-48" aria-label="Filter requests by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {GUEST_REQUEST_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {titleCase(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      <SectionCard
        title={`${rows.length} request(s)`}
        description="Ordered by the time each request is due. Overdue requests escalate automatically."
      >
        <QueryState
          isLoading={requests.isLoading}
          error={requests.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={ConciergeBell}
              title="No guest requests"
              description="Requests appear here as soon as they are logged against a stay, a room or a guest profile."
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Guest</TableHead>
                  <TableHead>Room</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Escalation</TableHead>
                  <TableHead>Feedback</TableHead>
                  <TableHead>Status</TableHead>
                  {mayEdit ? <TableHead className="text-right">Actions</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.customers?.full_name ?? "—"}</TableCell>
                    <TableCell>{r.rooms?.room_number ?? "—"}</TableCell>
                    <TableCell>
                      <div>{titleCase(r.category)}</div>
                      {r.description ? (
                        <p className="text-xs text-muted-foreground">{r.description}</p>
                      ) : null}
                      {r.resolution_notes ? (
                        <p className="text-xs text-muted-foreground">
                          Resolved: {r.resolution_notes}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>{r.departments?.name ?? "Unrouted"}</TableCell>
                    <TableCell>{titleCase(r.priority)}</TableCell>
                    <TableCell>
                      <StatusPill tone={dueTone(r.due_at, r.status)}>
                        {r.due_at ? new Date(r.due_at).toLocaleString() : "No due time"}
                      </StatusPill>
                    </TableCell>
                    <TableCell>
                      {(r.escalation_level ?? 0) > 0 ? (
                        <StatusPill tone="warning">Level {r.escalation_level}</StatusPill>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{r.feedback_rating ? `${r.feedback_rating}/5` : "—"}</TableCell>
                    <TableCell>{titleCase(r.status)}</TableCell>
                    {mayEdit ? (
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {r.status !== "completed" && r.status !== "cancelled" ? (
                            <>
                              {r.status === "new" ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={update.isPending}
                                  onClick={() => update.mutate({ id: r.id, status: "in-progress" })}
                                >
                                  Start
                                </Button>
                              ) : null}
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setAssigning(r.id)}
                              >
                                Assign
                              </Button>
                              <Button size="sm" onClick={() => setCompleting(r.id)}>
                                Complete
                              </Button>
                            </>
                          ) : (
                            <Button size="sm" variant="ghost" onClick={() => setRating(r.id)}>
                              Guest feedback
                            </Button>
                          )}
                          {r.status !== "cancelled" ? (
                            <Button size="sm" variant="outline" onClick={() => setCharging(r.id)}>
                              Charge to folio
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>

      <AssignDialog requestId={assigning} onClose={() => setAssigning(null)} />
      <CompleteDialog requestId={completing} onClose={() => setCompleting(null)} />
      <FeedbackDialog requestId={rating} onClose={() => setRating(null)} />
      <ChargeDialog requestId={charging} onClose={() => setCharging(null)} />
    </div>
  );
}

function AssignDialog({ requestId, onClose }: { requestId: string | null; onClose: () => void }) {
  const [assignee, setAssignee] = useState("");
  const [department, setDepartment] = useState("");
  const [reason, setReason] = useState("");

  const departments = useDepartmentsLite();
  const staff = useAssignableStaff(department || null);
  const assign = useAssignRequest();

  return (
    <Dialog open={Boolean(requestId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign this request</DialogTitle>
          <DialogDescription>
            Reassignments are kept in the request history and the new owner is notified.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Department</Label>
            <Select
              value={department}
              onValueChange={(value) => {
                setDepartment(value);
                setAssignee("");
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Keep current department" />
              </SelectTrigger>
              <SelectContent>
                {(departments.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Assign to</Label>
            <Select
              value={assignee}
              onValueChange={setAssignee}
              disabled={!department}
            >
              <SelectTrigger>
                <SelectValue placeholder={department ? "Select a worker" : "Select department first"} />
              </SelectTrigger>
              <SelectContent>
                {(staff.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.full_name ?? "Unnamed"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="assign-reason">Reason</Label>
            <Input id="assign-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <Button
            disabled={(!assignee && !department) || assign.isPending}
            onClick={() =>
              assign.mutate(
                {
                  request: requestId!,
                  assignee: assignee || null,
                  department: department || null,
                  reason,
                },
                { onSuccess: onClose },
              )
            }
          >
            Assign
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CompleteDialog({ requestId, onClose }: { requestId: string | null; onClose: () => void }) {
  const complete = useCompleteRequest();
  const [resolution, setResolution] = useState("");
  const [evidence, setEvidence] = useState("");

  return (
    <Dialog open={Boolean(requestId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete request</DialogTitle>
          <DialogDescription>
            Describe what was done. The completion is timestamped against the guest timeline.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="resolution">How was it resolved?</Label>
            <Textarea
              id="resolution"
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="evidence">Evidence link (optional)</Label>
            <Input
              id="evidence"
              value={evidence}
              onChange={(e) => setEvidence(e.target.value)}
              placeholder="Photo or document URL"
            />
          </div>
          <Button
            disabled={resolution.trim().length < 3 || complete.isPending}
            onClick={() =>
              complete.mutate({ request: requestId!, resolution, evidence }, { onSuccess: onClose })
            }
          >
            Mark complete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FeedbackDialog({ requestId, onClose }: { requestId: string | null; onClose: () => void }) {
  const feedback = useRequestFeedback();
  const [rating, setRating] = useState("5");
  const [comment, setComment] = useState("");

  return (
    <Dialog open={Boolean(requestId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record guest feedback</DialogTitle>
          <DialogDescription>
            Feedback flows to the guest profile and CRM where the viewer is permitted to see it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Rating</Label>
            <Select value={rating} onValueChange={setRating}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 5].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} / 5
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fb-comment">Comment</Label>
            <Textarea
              id="fb-comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
          </div>
          <Button
            disabled={feedback.isPending}
            onClick={() =>
              feedback.mutate(
                { request: requestId!, rating: Number(rating), comment },
                { onSuccess: onClose },
              )
            }
          >
            Save feedback
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Charging a guest request to the stay.
 *
 * Nothing is pre-filled: what is charged is exactly what the desk types, and
 * the posting goes through the same folio charge routine as every other
 * charge, so it lands on the guest's bill and in the audit trail once only.
 */
function ChargeDialog({ requestId, onClose }: { requestId: string | null; onClose: () => void }) {
  const charge = useChargeRequestToFolio();
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [taxRate, setTaxRate] = useState("0");
  const [reason, setReason] = useState("");

  const net = Number(quantity || 0) * Number(unitPrice || 0);
  const total = net + (net * Number(taxRate || 0)) / 100;

  return (
    <Dialog open={Boolean(requestId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Charge this request to the stay</DialogTitle>
          <DialogDescription>
            The charge is posted to the guest's open folio and recorded in the audit trail. A
            request can only be charged once.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="charge-desc">What is being charged?</Label>
            <Input
              id="charge-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Extra bed linen"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="charge-qty">Quantity</Label>
              <Input
                id="charge-qty"
                type="number"
                min={0}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="charge-price">Unit price</Label>
              <Input
                id="charge-price"
                type="number"
                min={0}
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="charge-tax">Tax %</Label>
              <Input
                id="charge-tax"
                type="number"
                min={0}
                value={taxRate}
                onChange={(e) => setTaxRate(e.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="charge-reason">Reason (optional)</Label>
            <Input id="charge-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <p className="text-sm text-muted-foreground">
            Total to post: <strong>{total.toLocaleString()}</strong>
          </p>
          <Button
            disabled={
              description.trim().length < 3 ||
              Number(quantity) <= 0 ||
              Number(unitPrice) <= 0 ||
              charge.isPending
            }
            onClick={() =>
              charge.mutate(
                {
                  request: requestId!,
                  description: description.trim(),
                  quantity: Number(quantity),
                  unitPrice: Number(unitPrice),
                  taxRate: Number(taxRate || 0),
                  reason,
                },
                { onSuccess: onClose },
              )
            }
          >
            {charge.isPending ? "Posting…" : "Post charge"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
