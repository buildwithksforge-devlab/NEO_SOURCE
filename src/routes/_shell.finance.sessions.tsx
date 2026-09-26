import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { AlertTriangle, ClipboardCheck, Wallet } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  StatCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { FinanceEmpty, FinanceQueryState, financeHead } from "@/components/finance/FinanceShared";
import { useAuth } from "@/lib/auth";
import { money, statusTone, titleCase } from "@/lib/finance";
import { useReviewCashShift } from "@/lib/frontdesk-ops";
import { useCashierSessions } from "@/lib/finance-controls";

export const Route = createFileRoute("/_shell/finance/sessions")({
  head: financeHead(
    "Cashier Sessions",
    "Every cashier session for the property with its opening float, expected cash, counted cash and variance, plus the independent review a cashier can never perform on their own till.",
  ),
  component: GuardedPage,
});

function CashierSessionsPage() {
  const { can, user } = useAuth();
  const sessions = useCashierSessions();
  const [reviewing, setReviewing] = useState<string | null>(null);

  const rows = sessions.data ?? [];
  const open = rows.filter((s) => s.status === "open");
  const variances = rows.filter((s) => Math.abs(Number(s.variance ?? 0)) > 0.009);
  const mayReview = can("finance", "sessions", "edit");

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Cashier Sessions"
        description="Cash accountability per cashier, reconciled against posted payments. A shortage or overage is investigated — it is never written off to make the day balance."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Sessions open now" value={String(open.length)} icon={Wallet} />
        <StatCard
          label="Sessions with a variance"
          value={String(variances.length)}
          tone={variances.length ? "warning" : "default"}
          icon={AlertTriangle}
        />
        <StatCard
          label="Your authority"
          value={mayReview ? "Can review sessions" : "View only"}
          icon={ClipboardCheck}
        />
      </div>

      <SectionCard
        title="Sessions"
        description="Most recent first. Review is independent: the reviewer is never the cashier who held the till."
      >
        <FinanceQueryState
          isLoading={sessions.isLoading}
          error={sessions.error}
          isEmpty={rows.length === 0}
          empty={
            <FinanceEmpty
              title="No cashier sessions yet"
              description="Sessions appear as soon as a cashier opens a till for this property."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Cashier</TableHead>
                  <TableHead>Opened</TableHead>
                  <TableHead className="text-right">Float</TableHead>
                  <TableHead className="text-right">Expected</TableHead>
                  <TableHead className="text-right">Counted</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Review</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => {
                  const variance = Number(s.variance ?? 0);
                  const own = s.cashier_id === user?.id;
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">
                        {s.shift_number ?? s.id.slice(0, 8)}
                      </TableCell>
                      <TableCell>{s.profiles?.full_name ?? "—"}</TableCell>
                      <TableCell>{new Date(s.opened_at).toLocaleString()}</TableCell>
                      <TableCell className="text-right">{money(s.opening_float ?? 0)}</TableCell>
                      <TableCell className="text-right">{money(s.expected_cash ?? 0)}</TableCell>
                      <TableCell className="text-right">
                        {s.counted_cash === null ? "—" : money(s.counted_cash)}
                      </TableCell>
                      <TableCell
                        className={
                          Math.abs(variance) > 0.009
                            ? "text-right font-semibold text-destructive"
                            : "text-right"
                        }
                      >
                        {money(variance)}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={statusTone(String(s.status))}>
                          {titleCase(String(s.status))}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        {s.status === "open" ? (
                          <span className="text-xs text-muted-foreground">Session still open</span>
                        ) : own ? (
                          <span className="text-xs text-muted-foreground">Your own till</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!mayReview}
                            onClick={() => setReviewing(s.id)}
                          >
                            Review
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableScroll>
        </FinanceQueryState>
      </SectionCard>

      <ReviewDialog shiftId={reviewing} onClose={() => setReviewing(null)} />
    </div>
  );
}

function ReviewDialog({ shiftId, onClose }: { shiftId: string | null; onClose: () => void }) {
  const review = useReviewCashShift();
  const [decision, setDecision] = useState("approved");
  const [notes, setNotes] = useState("");

  return (
    <Dialog open={Boolean(shiftId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Independent session review</DialogTitle>
          <DialogDescription>
            The decision and notes are audited. A rejected session stays open for investigation.
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
                <SelectItem value="rejected">Reject — investigate the variance</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="session-notes">Notes</Label>
            <Textarea id="session-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
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

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/finance/sessions">
      <CashierSessionsPage />
    </OpsGuard>
  );
}
