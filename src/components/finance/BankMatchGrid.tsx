/**
 * The match grid.
 *
 * Payments NEØ recorded sit on the left, lines the bank actually reported sit on
 * the right, and reconciliation is the act of pairing one with the other. Nothing
 * here creates money or clears itself: a pair is only made when somebody makes
 * it, and anything that cannot be paired is flagged rather than hidden.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Banknote, CheckCircle2, FileCheck2, Link2 } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useAutoMatchTransfers,
  useBankTransferQueue,
  useMarkLineReconciled,
  useMarkTransferReconciled,
  useMatchTransfer,
  type AwaitingTransfer,
  type OpenStatementLine,
} from "@/lib/bank-reconciliation";
import { money, shortDate } from "@/lib/finance";

type Flag = { label: string; tone: "warning" | "destructive" };

/** Everything the two sides disagree about, said plainly on the row it belongs to. */
function transferFlags(t: AwaitingTransfer, lines: OpenStatementLine[]): Flag[] {
  const flags: Flag[] = [];
  const sameAmount = lines.filter((l) => Math.abs(l.amount - t.amount) < 0.01);
  if (!t.reference) flags.push({ label: "No reference given", tone: "warning" });
  if (sameAmount.length === 0) flags.push({ label: "No bank line of this amount", tone: "destructive" });
  if (t.reference) {
    const exact = lines.filter((l) => (l.reference ?? "").trim().toLowerCase() === t.reference?.trim().toLowerCase());
    if (exact.length > 1) flags.push({ label: "Reference used more than once", tone: "destructive" });
    if (exact.length === 1 && Math.abs((exact[0]?.amount ?? 0) - t.amount) >= 0.01) {
      flags.push({ label: "Bank shows a different amount", tone: "destructive" });
    }
  }
  const ageDays = Math.floor((Date.now() - new Date(t.requested_at).getTime()) / 86_400_000);
  if (ageDays >= 7) flags.push({ label: `Waiting ${ageDays} days`, tone: "warning" });
  return flags;
}

export function BankMatchGrid({ branchId }: { branchId?: string | null }) {
  const queue = useBankTransferQueue(branchId ?? null);
  const match = useMatchTransfer();
  const auto = useAutoMatchTransfers();
  const [selectedTransfer, setSelectedTransfer] = useState<string | null>(null);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [reconcile, setReconcile] = useState<
    { kind: "transfer" | "line"; id: string; label: string } | null
  >(null);

  const awaiting = queue.data?.awaiting ?? [];
  const lines = queue.data?.open_lines ?? [];

  const transfer = awaiting.find((t) => t.attempt_id === selectedTransfer) ?? null;
  const line = lines.find((l) => l.entry_id === selectedLine) ?? null;

  const pairing = useMemo(() => {
    if (!transfer || !line) return null;
    const gap = Math.round((line.amount - transfer.amount) * 100) / 100;
    return {
      gap,
      ok: Math.abs(gap) < 0.01,
      sameReference:
        Boolean(transfer.reference) &&
        (line.reference ?? "").trim().toLowerCase() === transfer.reference?.trim().toLowerCase(),
    };
  }, [transfer, line]);

  const unmatchedCount = awaiting.length;

  return (
    <SectionCard
      title="Match grid"
      description="What NEØ recorded, beside what the bank reported. Pick one from each side to pair them."
      actions={
        <Button
          variant="outline"
          size="sm"
          disabled={auto.isPending || unmatchedCount === 0}
          onClick={() => auto.mutate({ branchId: branchId ?? null, commit: true })}
        >
          <Link2 className="mr-1.5 size-4" /> Match exact references
        </Button>
      }
    >
      {queue.isLoading ? (
        <p className="text-sm text-muted-foreground">Reading the register…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Recorded in NEØ · awaiting the bank ({awaiting.length})
              </p>
              {awaiting.length === 0 ? (
                <p className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm text-muted-foreground">
                  <CheckCircle2 className="size-4 text-success" />
                  No transfer is waiting on the bank.
                </p>
              ) : (
                awaiting.map((t) => {
                  const flags = transferFlags(t, lines);
                  const active = t.attempt_id === selectedTransfer;
                  return (
                    <button
                      type="button"
                      key={t.attempt_id}
                      onClick={() => setSelectedTransfer(active ? null : t.attempt_id)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium">{money(t.amount)}</span>
                        <span className="text-xs text-muted-foreground">{shortDate(t.requested_at)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t.module ?? "payment"} · reference {t.reference ?? "none given"}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {flags.map((f) => (
                          <Badge
                            key={f.label}
                            variant={f.tone === "destructive" ? "destructive" : "outline"}
                            className="text-[11px]"
                          >
                            <AlertTriangle className="mr-1 size-3" />
                            {f.label}
                          </Badge>
                        ))}
                      </div>
                      <div className="mt-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReconcile({
                              kind: "transfer",
                              id: t.attempt_id,
                              label: `${money(t.amount)} · ${t.reference ?? "no reference"}`,
                            });
                          }}
                        >
                          <FileCheck2 className="mr-1 size-3.5" /> Mark reconciled
                        </Button>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                On the bank statement · unmatched ({lines.length})
              </p>
              {lines.length === 0 ? (
                <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                  No unmatched statement line. Import a statement to reconcile against.
                </p>
              ) : (
                lines.map((l) => {
                  const active = l.entry_id === selectedLine;
                  return (
                    <button
                      type="button"
                      key={l.entry_id}
                      onClick={() => setSelectedLine(active ? null : l.entry_id)}
                      className={`w-full rounded-lg border p-3 text-left transition ${
                        active ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium">{money(l.amount)}</span>
                        <span className="text-xs text-muted-foreground">{shortDate(l.value_date)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {l.direction === "out" ? "Money out" : "Money in"} · {l.reference ?? l.description ?? "no reference"}
                      </p>
                      <div className="mt-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReconcile({
                              kind: "line",
                              id: l.entry_id,
                              label: `${money(l.amount)} · ${l.reference ?? l.description ?? "no reference"}`,
                            });
                          }}
                        >
                          <FileCheck2 className="mr-1 size-3.5" /> Not a payment
                        </Button>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
            <div className="text-sm">
              {!transfer || !line ? (
                <span className="text-muted-foreground">Choose one payment and one bank line to pair them.</span>
              ) : pairing?.ok ? (
                <span className="flex items-center gap-2 text-foreground">
                  <CheckCircle2 className="size-4 text-success" />
                  {money(transfer.amount)} agrees with the bank
                  {pairing.sameReference ? " and the reference matches exactly." : "."}
                </span>
              ) : (
                <span className="flex items-center gap-2 text-destructive">
                  <AlertTriangle className="size-4" />
                  The bank line is {money(Math.abs(pairing?.gap ?? 0))}{" "}
                  {(pairing?.gap ?? 0) > 0 ? "more" : "less"} than the payment, so they cannot be paired.
                </span>
              )}
            </div>
            <Button
              size="sm"
              disabled={!transfer || !line || !pairing?.ok || match.isPending}
              onClick={() => {
                if (!transfer || !line) return;
                match.mutate(
                  { attemptId: transfer.attempt_id, entryId: line.entry_id },
                  {
                    onSuccess: () => {
                      setSelectedTransfer(null);
                      setSelectedLine(null);
                    },
                  },
                );
              }}
            >
              <Banknote className="mr-1.5 size-4" /> Match and verify
            </Button>
          </div>
        </div>
      )}

      <ReconcileDialog target={reconcile} onClose={() => setReconcile(null)} />
    </SectionCard>
  );
}

function ReconcileDialog({
  target,
  onClose,
}: {
  target: { kind: "transfer" | "line"; id: string; label: string } | null;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const markTransfer = useMarkTransferReconciled();
  const markLine = useMarkLineReconciled();
  const busy = markTransfer.isPending || markLine.isPending;

  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) {
          setReason("");
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target?.kind === "line" ? "Explain this bank line" : "Mark this transfer reconciled"}
          </DialogTitle>
          <DialogDescription>
            {target?.kind === "line"
              ? "Bank charges, interest and sweeps are not payments. Say what this line is; it stays on the record with your name."
              : "This stands in for the bank's own confirmation, so it is only for money you know arrived. Your reason is kept with the payment."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm font-medium">{target?.label}</p>
          <div className="space-y-1.5">
            <Label>Reason</Label>
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Settled net of bank charges against statement of 8 September"
            />
            <p className="text-xs text-muted-foreground">At least eight characters.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={reason.trim().length < 8 || busy || !target}
            onClick={() => {
              if (!target) return;
              const done = {
                onSuccess: () => {
                  setReason("");
                  onClose();
                },
              };
              if (target.kind === "line") markLine.mutate({ entryId: target.id, reason: reason.trim() }, done);
              else markTransfer.mutate({ attemptId: target.id, reason: reason.trim() }, done);
            }}
          >
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
