/**
 * Delivery manager view of one order's collection PIN.
 *
 * The PIN itself is never shown here — the database only ever returns it to the
 * customer who placed the order. This panel shows whether it was issued, where
 * it went, how many wrong entries the rider has made and whether the delivery is
 * locked, and offers the three recovery actions: send it again, replace it, or
 * authorise a handover without it. Replacing and authorising both require a
 * written reason and both leave an audit record.
 */
import { useEffect, useState } from "react";
import { Eye, KeyRound, RefreshCw, Send, ShieldAlert } from "lucide-react";
import { QueryState } from "@/components/operations/OpsShared";
import { StatusPill } from "@/components/common/DataDisplay";
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
import { shortDateTime, titleCase } from "@/lib/delivery";
import {
  useDeliveryPinStatus,
  useOverrideDeliveryPin,
  useRegenerateDeliveryPin,
  useResendDeliveryPin,
  useRevealDeliveryPin,
} from "@/lib/delivery-data";

type Props = {
  orderId: string | null;
  orderNumber?: string | null;
  onOpenChange: (open: boolean) => void;
};

const CHANNEL_LABEL: Record<string, string> = {
  sms: "text message",
  email: "email",
  whatsapp: "WhatsApp",
};

const SEND_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  queued: "info" as never,
  sent: "success",
  failed: "destructive",
  no_contact: "warning",
};

const EVENT_LABEL: Record<string, string> = {
  issued: "PIN issued",
  sent: "Sent to customer",
  resent: "Sent again",
  "send-skipped": "Could not be sent",
  regenerated: "Replaced with a new PIN",
  "failed-attempt": "Wrong PIN entered",
  locked: "Locked after too many wrong entries",
  verified: "PIN accepted at handover",
  override: "Handover authorised without the PIN",
  revealed: "PIN revealed by a manager",
};

export function DeliveryPinDialog({ orderId, orderNumber, onOpenChange }: Props) {
  const status = useDeliveryPinStatus(orderId ?? undefined);
  const resend = useResendDeliveryPin();
  const regenerate = useRegenerateDeliveryPin();
  const override = useOverrideDeliveryPin();
  const reveal = useRevealDeliveryPin();
  const [regenerateReason, setRegenerateReason] = useState("");
  const [overrideReason, setOverrideReason] = useState("");
  const [revealReason, setRevealReason] = useState("");
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  // The PIN hides itself again shortly after it is shown, so it cannot be left
  // sitting on a shared screen.
  useEffect(() => {
    if (!revealed) return;
    if (secondsLeft <= 0) {
      setRevealed(null);
      return;
    }
    const t = setTimeout(() => setSecondsLeft((v) => v - 1), 1000);
    return () => clearTimeout(t);
  }, [revealed, secondsLeft]);

  const s = status.data;
  const permitted = Boolean(s?.ok);
  const busy = resend.isPending || regenerate.isPending || override.isPending || reveal.isPending;

  const close = (open: boolean) => {
    if (!open) {
      setRegenerateReason("");
      setOverrideReason("");
      setRevealReason("");
      setConfirmReveal(false);
      setRevealed(null);
      setSecondsLeft(0);
    }
    onOpenChange(open);
  };

  const doReveal = () => {
    if (!orderId) return;
    reveal.mutate(
      { orderId, reason: revealReason.trim() },
      {
        onSuccess: (r) => {
          if (r?.ok && r.pin) {
            setRevealed(r.pin);
            setSecondsLeft(r.mask_after_seconds ?? 30);
            setRevealReason("");
            setConfirmReveal(false);
          }
        },
      },
    );
  };

  return (
    <Dialog open={Boolean(orderId)} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <KeyRound className="mr-1.5 inline size-4" />
            Collection PIN — {orderNumber ?? "order"}
          </DialogTitle>
          <DialogDescription>
            The PIN goes to the customer only. Nobody on this screen, and no rider, can read it.
          </DialogDescription>
        </DialogHeader>

        <QueryState
          isLoading={status.isLoading}
          error={status.error}
          isEmpty={!s}
          empty={<p className="text-sm text-muted-foreground">No PIN record for this order.</p>}
        >
          {!permitted ? (
            <p className="text-sm text-muted-foreground">
              {s?.reason === "not_permitted"
                ? "You do not have permission to manage collection PINs."
                : "This order has no collection PIN."}
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={s?.consumed_at ? "success" : s?.locked ? "destructive" : "info"}>
                  {s?.consumed_at ? "Used at handover" : s?.locked ? "Locked" : "Active"}
                </StatusPill>
                
                <StatusPill tone={SEND_TONE[s?.send_status ?? ""] ?? "default"}>
                  {s?.send_status === "no_contact"
                    ? "No contact to send to"
                    : s?.sent_at
                      ? `Sent by ${CHANNEL_LABEL[s?.channel ?? ""] ?? titleCase(s?.channel ?? "")}`
                      : "Not sent"}
                </StatusPill>
                {s?.override_at ? <StatusPill tone="warning">Handover authorised</StatusPill> : null}
                {s?.is_legacy ? <StatusPill tone="warning">Issued before PIN security</StatusPill> : null}
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                <Detail label="Issued" value={s?.issued_at ? shortDateTime(s.issued_at) : "—"} />
                <Detail label="Expires" value={s?.expires_at ? shortDateTime(s.expires_at) : "No expiry"} />
                <Detail label="Last sent" value={s?.sent_at ? shortDateTime(s.sent_at) : "Never"} />
                <Detail
                  label="Wrong entries"
                  value={`${s?.attempt_count ?? 0} of ${s?.max_attempts ?? 5}`}
                />
                <Detail label="Times replaced" value={String(s?.regenerated_count ?? 0)} />
                <Detail label="Used at" value={s?.consumed_at ? shortDateTime(s.consumed_at) : "—"} />
              </dl>

              {s?.send_detail ? <p className="text-xs text-muted-foreground">{s.send_detail}</p> : null}
              {s?.override_reason ? (
                <p className="text-xs text-muted-foreground">
                  Handover authorised: {s.override_reason}
                </p>
              ) : null}

              <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                {revealed ? (
                  <div className="space-y-1">
                    <p className="font-mono text-2xl font-semibold tracking-[0.3em]">{revealed}</p>
                    <p className="text-xs text-muted-foreground">
                      Hidden again in {secondsLeft}s. Give it to the rider verbally — this reveal was
                      recorded against your name.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="pin-reveal-reason">Reveal the PIN — reason</Label>
                    <Textarea
                      id="pin-reveal-reason"
                      rows={2}
                      value={revealReason}
                      onChange={(e) => {
                        setRevealReason(e.target.value);
                        setConfirmReveal(false);
                      }}
                      placeholder="Why can this customer not receive their PIN?"
                    />
                    <Button
                      size="sm"
                      variant={confirmReveal ? "destructive" : "outline"}
                      disabled={busy || !revealReason.trim() || Boolean(s?.consumed_at) || !orderId}
                      onClick={() => (confirmReveal ? doReveal() : setConfirmReveal(true))}
                    >
                      <Eye className="mr-1.5 size-3.5" />
                      {reveal.isPending
                        ? "Revealing…"
                        : confirmReveal
                          ? "Confirm — show the PIN and record it"
                          : "Reveal PIN"}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Only do this when the customer cannot receive the PIN. It is shown for 30
                      seconds and logged with your name and reason.
                    </p>
                  </div>
                )}
              </div>

              <div className="space-y-3 rounded-lg border border-border/60 p-3">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || Boolean(s?.consumed_at) || !orderId}
                  onClick={() => orderId && resend.mutate({ orderId })}
                >
                  <Send className="mr-1.5 size-3.5" />
                  {resend.isPending ? "Sending…" : "Send the same PIN again"}
                </Button>

                <div className="space-y-2">
                  <Label htmlFor="pin-regenerate-reason">Replace the PIN — reason</Label>
                  <Textarea
                    id="pin-regenerate-reason"
                    rows={2}
                    value={regenerateReason}
                    onChange={(e) => setRegenerateReason(e.target.value)}
                    placeholder="Why does this customer need a different PIN?"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !regenerateReason.trim() || Boolean(s?.consumed_at) || !orderId}
                    onClick={() =>
                      orderId && regenerate.mutate({ orderId, reason: regenerateReason.trim() })
                    }
                  >
                    <RefreshCw className="mr-1.5 size-3.5" />
                    {regenerate.isPending ? "Replacing…" : "Replace and send a new PIN"}
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="pin-override-reason">
                    Allow handover without the PIN — reason
                  </Label>
                  <Textarea
                    id="pin-override-reason"
                    rows={2}
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                    placeholder="Why can this delivery be completed without the PIN?"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !overrideReason.trim() || Boolean(s?.consumed_at) || !orderId}
                    onClick={() => orderId && override.mutate({ orderId, reason: overrideReason.trim() })}
                  >
                    <ShieldAlert className="mr-1.5 size-3.5" />
                    {override.isPending ? "Authorising…" : "Unlock and authorise handover"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    The rider still has to record who received the order.
                  </p>
                </div>
              </div>

              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">History</p>
                {(s?.events ?? []).length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">Nothing recorded yet.</p>
                ) : (
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                    {(s?.events ?? []).map((e, i) => (
                      <li key={`${e.created_at}-${i}`}>
                        {shortDateTime(e.created_at)} · {EVENT_LABEL[e.event_type] ?? titleCase(e.event_type)}
                        {e.reason ? ` — ${e.reason}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </QueryState>

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
