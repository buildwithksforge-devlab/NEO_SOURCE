import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Wallet } from "lucide-react";
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
import { EmptyState, PosGuard, QueryState } from "@/components/pos/PosShared";
import { money, titleCase } from "@/lib/pos";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useMyOpenShift, usePosShifts } from "@/lib/pos-data";
import {
  useCloseCashShift,
  useOpenCashShift,
  useRecordCashMovement,
  useReviewCashShift,
  useShiftExpected,
  useShiftMovements,
} from "@/lib/frontdesk-ops";

export const Route = createFileRoute("/_shell/pos/shifts")({
  head: () => ({
    meta: [
      { title: "Shift & Cash Management — NEØ" },
      {
        name: "description",
        content:
          "Cashier sessions with opening float, drops, paid-outs, expected cash, counted cash, variance and independent manager review.",
      },
      { property: "og:title", content: "Shift & Cash Management — NEØ" },
      {
        property: "og:description",
        content:
          "Cashier sessions with opening float, drops, paid-outs, expected cash, variance and independent review.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="shifts.view" path="/pos/shifts">
      <ShiftsPage />
    </PosGuard>
  ),
});

function ShiftsPage() {
  const { can, user } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const mine = useMyOpenShift();
  const shifts = usePosShifts();
  const shiftId = mine.data?.id ?? null;
  const expected = useShiftExpected(shiftId);
  const movements = useShiftMovements(shiftId);
  const openShift = useOpenCashShift();
  const closeShift = useCloseCashShift();
  const [float, setFloat] = useState("");
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [movementOpen, setMovementOpen] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);

  const mayReview = can("pos", "shifts.edit") || can("finance", "banking.edit");
  const expectedCash = expected.data === undefined ? null : Number(expected.data);
  const variance = expectedCash !== null && counted !== "" ? Number(counted) - expectedCash : null;

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title="Shift & Cash Management"
        description="Cash accountability per cashier. Expected cash is derived from posted payments less drops and paid-outs — a variance can never be closed silently."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard
          title="My session"
          description="One open session per cashier. Every cash payment must reference it."
        >
          {mine.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading your session…</p>
          ) : mine.data ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-muted-foreground">Opened</p>
                  <p className="font-medium">{new Date(mine.data.opened_at).toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Opening float</p>
                  <p className="font-medium">{money(mine.data.opening_float)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Expected cash</p>
                  <p className="font-medium">
                    {expected.isLoading
                      ? "Calculating…"
                      : expectedCash === null
                        ? "Unavailable"
                        : money(expectedCash)}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Variance if closed now</p>
                  <p className="font-medium">{variance === null ? "—" : money(variance)}</p>
                </div>
              </div>

              <Button variant="outline" size="sm" onClick={() => setMovementOpen(true)}>
                Record drop or paid-out
              </Button>

              <div className="grid gap-1.5">
                <Label htmlFor="counted">Counted cash</Label>
                <Input
                  id="counted"
                  inputMode="decimal"
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="variance-reason">
                  Variance explanation (required if the count differs)
                </Label>
                <Input
                  id="variance-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <Button
                disabled={
                  counted === "" ||
                  closeShift.isPending ||
                  (Boolean(variance) && reason.trim().length < 3)
                }
                onClick={() =>
                  closeShift.mutate(
                    { shift: mine.data!.id, counted: Number(counted), reason },
                    {
                      onSuccess: () => {
                        setCounted("");
                        setReason("");
                      },
                    },
                  )
                }
              >
                Close shift
              </Button>

              <div>
                <h3 className="mb-2 text-sm font-medium">Movements this session</h3>
                <QueryState
                  isLoading={movements.isLoading}
                  error={movements.error}
                  isEmpty={(movements.data ?? []).length === 0}
                  empty={
                    <p className="text-sm text-muted-foreground">No drops or paid-outs recorded.</p>
                  }
                >
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Type</TableHead>
                        <TableHead>Amount</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(movements.data ?? []).map((m) => (
                        <TableRow key={m.id}>
                          <TableCell>{titleCase(m.movement_type ?? "")}</TableCell>
                          <TableCell>{money(m.amount)}</TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {m.reason ?? "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </QueryState>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-1.5">
                <Label htmlFor="float">Opening float</Label>
                <Input
                  id="float"
                  inputMode="decimal"
                  value={float}
                  onChange={(e) => setFloat(e.target.value)}
                />
              </div>
              <Button
                disabled={float === "" || openShift.isPending}
                onClick={() =>
                  openShift.mutate(
                    { branch: branchId, station: null, float: Number(float) },
                    { onSuccess: () => setFloat("") },
                  )
                }
              >
                Open shift
              </Button>
            </div>
          )}
        </SectionCard>

        <SectionCard
          title="Recent sessions"
          description="Closed sessions and any variances awaiting independent review."
        >
          <QueryState
            isLoading={shifts.isLoading}
            error={shifts.error}
            isEmpty={(shifts.data ?? []).length === 0}
            empty={
              <EmptyState
                icon={Wallet}
                title="No sessions yet"
                description="Cash sessions appear here once cashiers start trading."
              />
            }
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cashier</TableHead>
                    <TableHead>Opened</TableHead>
                    <TableHead>Expected</TableHead>
                    <TableHead>Counted</TableHead>
                    <TableHead>Variance</TableHead>
                    <TableHead>Status</TableHead>
                    {mayReview ? <TableHead className="text-right">Review</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(shifts.data ?? []).map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>{s.profiles?.full_name ?? "—"}</TableCell>
                      <TableCell>{new Date(s.opened_at).toLocaleString()}</TableCell>
                      <TableCell>
                        {s.expected_cash === null ? "—" : money(s.expected_cash)}
                      </TableCell>
                      <TableCell>{s.counted_cash === null ? "—" : money(s.counted_cash)}</TableCell>
                      <TableCell>{s.variance === null ? "—" : money(s.variance)}</TableCell>
                      <TableCell>
                        <StatusPill
                          tone={
                            s.status === "closed"
                              ? "success"
                              : s.status === "open"
                                ? "info"
                                : "warning"
                          }
                        >
                          {titleCase(s.status)}
                        </StatusPill>
                      </TableCell>
                      {mayReview ? (
                        <TableCell className="text-right">
                          {s.status === "closed" || s.status === "open" ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : s.cashier_id === user?.id ? (
                            <span className="text-xs text-muted-foreground">Own shift</span>
                          ) : (
                            <Button size="sm" variant="outline" onClick={() => setReviewing(s.id)}>
                              Review
                            </Button>
                          )}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </QueryState>
        </SectionCard>
      </div>

      <MovementDialog
        open={movementOpen}
        shiftId={shiftId}
        onClose={() => setMovementOpen(false)}
      />
      <ReviewDialog shiftId={reviewing} onClose={() => setReviewing(null)} />
    </div>
  );
}

function MovementDialog({
  open,
  shiftId,
  onClose,
}: {
  open: boolean;
  shiftId: string | null;
  onClose: () => void;
}) {
  const record = useRecordCashMovement();
  const [type, setType] = useState("drop");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record cash movement</DialogTitle>
          <DialogDescription>
            Drops and paid-outs adjust the expected cash for this session.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="drop">Drop to safe</SelectItem>
                <SelectItem value="payout">Paid-out</SelectItem>
                <SelectItem value="top-up">Float top-up</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mv-amount">Amount</Label>
            <Input
              id="mv-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mv-reason">Reason</Label>
            <Textarea id="mv-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="mv-ref">Reference (optional)</Label>
            <Input id="mv-ref" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
          <Button
            disabled={!shiftId || amount === "" || reason.trim().length < 3 || record.isPending}
            onClick={() =>
              record.mutate(
                { shift: shiftId!, type, amount: Number(amount), reason, reference },
                {
                  onSuccess: () => {
                    setAmount("");
                    setReason("");
                    setReference("");
                    onClose();
                  },
                },
              )
            }
          >
            Record movement
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReviewDialog({ shiftId, onClose }: { shiftId: string | null; onClose: () => void }) {
  const review = useReviewCashShift();
  const [decision, setDecision] = useState("approved");
  const [notes, setNotes] = useState("");

  return (
    <Dialog open={Boolean(shiftId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Independent shift review</DialogTitle>
          <DialogDescription>
            A cashier can never review their own session. The decision and notes are audited.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Decision</Label>
            <Select value={decision} onValueChange={setDecision}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="approved">Approve and post to Finance</SelectItem>
                <SelectItem value="rejected">Reject — investigate variance</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="review-notes">Notes</Label>
            <Textarea id="review-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <Button
            disabled={notes.trim().length < 3 || review.isPending}
            onClick={() =>
              review.mutate({ shift: shiftId!, decision, notes }, { onSuccess: onClose })
            }
          >
            Submit review
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
