/**
 * Pre-arrival deposit container.
 *
 * Shows the liability held against a reservation — required, received,
 * outstanding — and lets an authorised user record a deposit or request a
 * single-use check-in override. The figures come from the database position,
 * so they survive a refresh, a reopen and a new session unchanged.
 */
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import { money } from "@/lib/pms";
import { PAYMENT_METHOD_CATALOGUE } from "@/lib/payment-methods";
import { PaymentMethodPicker } from "@/components/payments/PaymentMethodPicker";
import {
  depositGate,
  depositIdempotencyKey,
  useDepositOverride,
  useDepositPosition,
  useRecordDeposit,
} from "@/lib/deposits";

/** Same names as every other payment surface, from the one catalogue. */
const METHODS = ["cash", "card", "mpesa", "bank-transfer", "voucher"].flatMap((v) =>
  PAYMENT_METHOD_CATALOGUE.filter((m) => m.value === v),
);

export function DepositPanel({ reservationId }: { reservationId: string }) {
  const { can } = useAuth();
  const { activeBranchId } = useBranchScope();
  const position = useDepositPosition(reservationId);
  const record = useRecordDeposit();
  const override = useDepositOverride();

  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");

  const p = position.data;
  const gate = depositGate(p);
  const mayRecord = can("pms", "reservations.edit") || can("finance", "collections.collect_payment");
  const mayOverride = can("front-office", "folios.approve");

  return (
    <SectionCard
      title="Deposit"
      description="Held against this reservation before arrival. A deposit is a liability, never revenue."
    >
      {position.isLoading ? (
        <p className="text-sm text-muted-foreground">Reading the deposit position…</p>
      ) : position.error ? (
        <p className="text-sm text-destructive">{(position.error as Error).message}</p>
      ) : !p?.ok ? (
        <p className="text-sm text-muted-foreground">{p?.reason ?? "No deposit position."}</p>
      ) : (
        <div className="space-y-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <Figure label="Required" value={money(p.required ?? 0)} />
            <Figure label="Received" value={money(p.paid ?? 0)} />
            <Figure label="Applied to folio" value={money(p.applied ?? 0)} />
            <Figure label="Outstanding" value={money(p.outstanding ?? 0)} />
          </dl>

          {p.policy_name ? (
            <p className="text-xs text-muted-foreground">
              Required by policy <span className="font-medium">{p.policy_name}</span> —{" "}
              {p.policy_reason ?? "property deposit rule"} ({money(p.policy_amount ?? 0)}).
            </p>
          ) : p.required_source === "manual" && (p.required ?? 0) > 0 ? (
            <p className="text-xs text-muted-foreground">
              Deposit entered by hand on this reservation; no property policy applied.
            </p>
          ) : null}

          <div
            className={`rounded-lg border p-3 text-sm ${
              gate.blocked
                ? "border-warning/40 bg-warning/10"
                : "border-border/70 bg-muted/30 text-muted-foreground"
            }`}
          >
            {gate.blocked ? null : <ShieldCheck className="mr-1 inline size-4" />}
            {gate.message}
            {p.waiver ? (
              <Badge variant="outline" className="ml-2">
                {p.waiver}
              </Badge>
            ) : null}
          </div>

          {mayRecord ? (
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem_1fr_auto] sm:items-end">
              <div className="grid gap-1.5">
                <Label htmlFor="dep-amount">Amount</Label>
                <Input
                  id="dep-amount"
                  type="number"
                  min={0}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <PaymentMethodPicker methods={METHODS} value={method} onChange={setMethod} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="dep-ref">Reference</Label>
                <Input
                  id="dep-ref"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Receipt or transaction number"
                />
              </div>
              <Button
                disabled={!amount || Number(amount) <= 0 || record.isPending}
                onClick={() => {
                  record.mutate(
                    {
                      reservationId,
                      amount: Number(amount),
                      method,
                      ...(reference ? { reference } : {}),
                      idempotencyKey: depositIdempotencyKey({
                        reservationId,
                        propertyId: activeBranchId === "all" ? null : (activeBranchId ?? null),
                        amount: Number(amount),
                        method,
                        ...(reference ? { reference } : {}),
                      }),
                    },
                    {
                      onSuccess: () => {
                        setAmount("");
                        setReference("");
                      },
                    },
                  );
                }}
              >
                Record deposit
              </Button>
            </div>
          ) : null}

          {gate.blocked && mayOverride ? (
            <div className="grid gap-2 rounded-lg border border-border/70 p-3">
              <Label htmlFor="dep-override">Authorise check-in without the deposit</Label>
              <Textarea
                id="dep-override"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Policy reason for waiving the deposit at check-in"
              />
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={reason.trim().length < 5 || override.isPending}
                  onClick={() =>
                    override.mutate(
                      {
                        reservationId,
                        reason: reason.trim(),
                        authority: "front-office.folios.approve",
                      },
                      { onSuccess: () => setReason("") },
                    )
                  }
                >
                  Authorise override
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                The override is single-use: it authorises this arrival only, and is recorded with
                your name, the reason and the outstanding amount.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}
