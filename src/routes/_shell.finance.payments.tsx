/**
 * The payment register â€” every collection, whatever module took it.
 *
 * Rows come from one source (`neo_payment_register`), which the database keeps
 * in step with folio payments, till payments, event payments and M-Pesa
 * requests. Nothing here is inferred in the browser: a payment shows the stage
 * the record itself has reached, so a request that was merely sent can never
 * read as money received.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/common/DataDisplay";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DataTable,
  FinanceEmpty,
  FinanceGuard,
  FinanceQueryState,
  FinStatus,
  financeHead,
} from "@/components/finance/FinanceShared";
import { money, shortDate, titleCase } from "@/lib/finance";
import { useFinanceFactScope } from "@/lib/finance-data";
import { useAuth } from "@/lib/auth";
import { usePaymentLifecycle } from "@/lib/payment-lifecycle";
import { DeliveryTillVerification } from "@/components/finance/DeliveryTillVerification";
import {
  PAYMENT_STATES,
  PAYMENT_STATE_HINT,
  PAYMENT_STATE_LABEL,
  summarisePaymentRegister,
  usePaymentRegister,
  useVerifyManualTender,
  type PaymentAttempt,
  type PaymentState,
} from "@/lib/payment-register";

export const Route = createFileRoute("/_shell/finance/payments")({
  head: financeHead(
    "Payment Register",
    "Every payment taken across rooms, restaurants, events and M-Pesa, with the exact stage each one has reached.",
  ),
  component: () => (
    <FinanceGuard feature="collections">
      <PaymentsPage />
    </FinanceGuard>
  ),
});

const MODULE_LABEL: Record<string, string> = {
  pms: "Rooms & folios",
  pos: "Restaurant & bar",
  events: "Events",
  mpesa: "M-Pesa",
  finance: "Finance",
};

function PaymentsPage() {
  const scope = useFinanceFactScope();
  const { can } = useAuth();
  const [stateFilter, setStateFilter] = useState<"all" | PaymentState>("all");
  const [moduleFilter, setModuleFilter] = useState("all");
  const verify = useVerifyManualTender();

  const register = usePaymentRegister({
    branchId: scope.branchId,
    from: scope.from,
    to: scope.to,
  });

  const rows = useMemo(() => {
    const all = register.data ?? [];
    return all.filter(
      (r) =>
        (stateFilter === "all" || r.state === stateFilter) &&
        (moduleFilter === "all" || r.source_module === moduleFilter),
    );
  }, [register.data, stateFilter, moduleFilter]);

  const modules = useMemo(
    () => Array.from(new Set((register.data ?? []).map((r) => r.source_module))).sort(),
    [register.data],
  );

  // The canonical lifecycle decides whether money is in the ledger; the register
  // row only says what the collecting module recorded.
  const lifecycle = usePaymentLifecycle({
    branchId: scope.branchId,
    from: scope.from,
    to: scope.to,
  });
  const ledgerByPayment = useMemo(() => {
    const map = new Map<string, { stageLabel: string; journalNumber: string | null }>();
    for (const l of lifecycle.data ?? []) {
      map.set(l.paymentId, { stageLabel: l.stageLabel, journalNumber: l.journalNumber });
    }
    return map;
  }, [lifecycle.data]);

  const totals = useMemo(() => summarisePaymentRegister(rows), [rows]);
  const mayVerify = can("finance", "approve") || can("finance", "collections.approve");

  const lead: SummaryFigure = {
    id: "received",
    label: "Money received",
    value: money(totals.received),
    hint: `${totals.count} collections`,
  };
  const figures: SummaryFigure[] = [
    { id: "posted", label: "In the ledger", value: money(totals.posted) },
    {
      id: "awaiting",
      label: "Awaiting confirmation",
      value: money(totals.awaiting),
      hint: totals.awaitingCount ? `${totals.awaitingCount} not received yet` : "Nothing waiting",
    },
    {
      id: "unsuccessful",
      label: "Did not go through",
      value: money(totals.unsuccessful),
      hint: totals.unsuccessfulCount
        ? `${totals.unsuccessfulCount} failed, cancelled or timed out`
        : "None",
      tone: totals.unsuccessfulCount ? "destructive" : "default",
    },
    {
      id: "unverified",
      label: "Unverified tenders",
      value: String(totals.unverified),
      hint: totals.unverified
        ? "Recorded by hand, not yet checked against outside evidence"
        : "All checked",
      tone: totals.unverified ? "destructive" : "default",
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Payment register"
        description="One record per act of collection, from the request through to the ledger. A payment is never treated as received until the provider or the cashier says so."
      />

      <SummaryStrip lead={lead} figures={figures} />

      {mayVerify ? <DeliveryTillVerification /> : null}

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <Label className="text-xs text-muted-foreground">Stage</Label>
          <Select
            value={stateFilter}
            onValueChange={(v) => setStateFilter(v as typeof stateFilter)}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any stage</SelectItem>
              {PAYMENT_STATES.map((s) => (
                <SelectItem key={s} value={s}>
                  {PAYMENT_STATE_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Taken by</Label>
          <Select value={moduleFilter} onValueChange={setModuleFilter}>
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Everywhere</SelectItem>
              {modules.map((m) => (
                <SelectItem key={m} value={m}>
                  {MODULE_LABEL[m] ?? titleCase(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">
          {shortDate(scope.from)} â€“ {shortDate(scope.to)}
        </p>
      </div>

      <FinanceQueryState
        isLoading={register.isLoading || lifecycle.isLoading}
        error={register.error ?? lifecycle.error}
        isEmpty={rows.length === 0}
        empty={
          <FinanceEmpty
            title="No payments in this period"
            description="Payments appear here the moment a folio, till, event or M-Pesa collection is started."
          />
        }
      >
        <DataTable
          head={["Reference", "Taken by", "Method", "Stage", "Amount", "Verified", ""]}
          unit="payments"
        >
          {rows.map((r) => (
            <Row
              key={r.id}
              row={r}
              ledger={ledgerByPayment.get(r.payment_id) ?? null}
              mayVerify={mayVerify}
              onVerify={(id) => verify.mutate({ attemptId: id })}
              busy={verify.isPending}
            />
          ))}
        </DataTable>
      </FinanceQueryState>
    </div>
  );
}

function Row({
  row,
  ledger,
  mayVerify,
  onVerify,
  busy,
}: {
  row: PaymentAttempt;
  ledger: { stageLabel: string; journalNumber: string | null } | null;
  mayVerify: boolean;
  onVerify: (id: string) => void;
  busy: boolean;
}) {
  const settled = row.state === "confirmed" || row.state === "posted";
  const needsVerification = row.manual_tender && settled && !row.verified_at;
  return (
    <tr>
      <td className="py-2 pr-4 font-medium">
        {row.reference ?? "â€”"}
        <span className="block text-xs text-muted-foreground">
          {shortDate(row.requested_at)}
          {row.environment ? ` Â· ${row.environment}` : ""}
        </span>
      </td>
      <td className="py-2 pr-4">
        {MODULE_LABEL[row.source_module] ?? titleCase(row.source_module)}
      </td>
      <td className="py-2 pr-4">
        {titleCase(row.method.replace(/-/g, " "))}
        {row.manual_tender ? (
          <span className="block text-xs text-muted-foreground">Recorded by hand</span>
        ) : (
          <span className="block text-xs text-muted-foreground">Provider confirmed</span>
        )}
      </td>
      <td className="py-2 pr-4">
        <FinStatus value={ledger?.stageLabel ?? PAYMENT_STATE_LABEL[row.state]} />
        <span className="block text-xs text-muted-foreground">
          {ledger?.journalNumber ?? row.state_detail ?? PAYMENT_STATE_HINT[row.state]}
        </span>
      </td>
      <td className="py-2 pr-4 tabular-nums">
        {money(Number(row.amount))}
        {row.change_due ? (
          <span className="block text-xs text-muted-foreground">
            Change {money(Number(row.change_due))}
          </span>
        ) : null}
      </td>
      <td className="py-2 pr-4 text-xs">
        {row.verified_at ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" /> {shortDate(row.verified_at)}
          </span>
        ) : needsVerification ? (
          <span className="text-destructive">Not checked</span>
        ) : (
          "â€”"
        )}
      </td>
      <td className="py-2">
        {needsVerification && mayVerify ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onVerify(row.id)}>
            Verify
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

