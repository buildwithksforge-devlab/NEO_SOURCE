/**
 * Awaiting-collection stage of the canonical cashier queue.
 *
 * Departments raise the bill; the cashier confirms the money. This is the
 * *first* half of the queue — money not yet taken. Once taken, the same
 * transaction moves to the posting stage, which reads its status from the
 * database rather than from this screen.
 *
 * Rules enforced here:
 *  - cash cannot be collected without an open till, so the count reconciles;
 *  - one collector per collection — the signed-in cashier's open session;
 *  - tendered and change are shown and carried onto the receipt;
 *  - a submitted collection cannot be submitted twice, by click or by refresh.
 */
import { useMemo, useRef, useState } from "react";
import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { methodsFor, PaymentMethodPicker } from "@/components/payments/PaymentMethodPicker";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
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
import { StatusPill, TableScroll } from "@/components/common/DataDisplay";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FinanceEmpty, FinanceQueryState } from "@/components/finance/FinanceShared";
import { useAuth } from "@/lib/auth";
import { money, statusTone, titleCase } from "@/lib/finance";
import { useMyOpenShift } from "@/lib/pos-data";
import { collectionKey, evaluateCollection } from "@/lib/collection-rules";
import {
  COLLECTION_SOURCES,
  usePendingCollections,
  useSettleCollection,
  type PendingCollection,
} from "@/lib/finance-controls";

/** The cashier takes the same tenders as every other desk, from the one catalogue. */
const METHODS = methodsFor([
  "cash",
  "card",
  "card-terminal",
  "mpesa",
  "qr",
  "bank-transfer",
  "corporate-credit",
  "voucher",
]);

export function CollectionStage() {
  const { can } = useAuth();
  const collections = usePendingCollections();
  const [source, setSource] = useState("all");
  const [selected, setSelected] = useState<PendingCollection | null>(null);
  const [inspecting, setInspecting] = useState<PendingCollection | null>(null);

  const rows = collections.data ?? [];
  const filtered = useMemo(
    () => (source === "all" ? rows : rows.filter((r) => r.source === source)),
    [rows, source],
  );
  const outstanding = rows.reduce((n, r) => n + Number(r.balance ?? 0), 0);
  const mayCollect =
    can("finance", "collections", "collect_payment") || can("finance", "collections", "create");

  const lead: SummaryFigure = {
    id: "outstanding",
    label: "Total outstanding",
    value: collections.isLoading ? "…" : money(outstanding),
    hint: `${rows.length} bill(s) awaiting collection`,
  };
  const figures: SummaryFigure[] = Object.entries(COLLECTION_SOURCES).map(([key, label]) => ({
    id: key,
    label,
    value: collections.isLoading ? "…" : rows.filter((r) => r.source === key).length,
    onSelect: () => setSource((prev) => (prev === key ? "all" : key)),
    active: source === key,
  }));

  return (
    <div className="space-y-4">
      <SummaryStrip lead={lead} figures={figures} />

      <div className="surface-panel rounded-2xl p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">{filtered.length} bill(s)</p>
          <span className="text-xs text-muted-foreground">
            {mayCollect ? "Can collect payment" : "View only"}
          </span>
        </div>
        <FinanceQueryState
          isLoading={collections.isLoading}
          error={collections.error}
          isEmpty={filtered.length === 0}
          empty={
            <FinanceEmpty
              title="Nothing awaiting collection"
              description="Every bill raised for this property has been settled or transferred to an authorised account."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Guest / account</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Adjustments</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => (
                  <TableRow
                    key={`${row.source}-${row.source_id}`}
                    className="cursor-pointer"
                    onClick={() => setInspecting(row)}
                  >
                    <TableCell className="font-mono text-xs">{row.reference ?? "—"}</TableCell>
                    <TableCell>
                      {row.department ?? COLLECTION_SOURCES[row.source] ?? row.source}
                    </TableCell>
                    <TableCell>{row.customer ?? "—"}</TableCell>
                    <TableCell className="text-right">{money(row.gross)}</TableCell>
                    <TableCell className="text-right">{money(row.adjustments)}</TableCell>
                    <TableCell className="text-right">{money(row.deposit)}</TableCell>
                    <TableCell className="text-right font-semibold">{money(row.balance)}</TableCell>
                    <TableCell>
                      <StatusPill tone={statusTone(String(row.payment_status ?? "unpaid"))}>
                        {titleCase(String(row.payment_status ?? "unpaid"))}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {row.source === "delivery" ? (
                        <span className="text-xs text-muted-foreground">Collected on delivery</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!mayCollect}
                          onClick={() => setSelected(row)}
                        >
                          Verify &amp; collect
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </FinanceQueryState>
      </div>

      <InspectorSheet
        open={Boolean(inspecting)}
        onOpenChange={(open) => !open && setInspecting(null)}
        title={inspecting?.reference ?? "Bill"}
        subtitle={inspecting?.customer ?? undefined}
        chips={
          inspecting ? (
            <StatusPill tone={statusTone(String(inspecting.payment_status ?? "unpaid"))}>
              {titleCase(String(inspecting.payment_status ?? "unpaid"))}
            </StatusPill>
          ) : null
        }
        footer={
          inspecting && inspecting.source !== "delivery" ? (
            <Button
              disabled={!mayCollect}
              onClick={() => {
                setSelected(inspecting);
                setInspecting(null);
              }}
            >
              Verify &amp; collect
            </Button>
          ) : null
        }
      >
        {inspecting ? (
          <InspectorSection title="Bill">
            <InspectorField label="Department">
              {inspecting.department ?? COLLECTION_SOURCES[inspecting.source] ?? inspecting.source}
            </InspectorField>
            <InspectorField label="Gross">{money(inspecting.gross)}</InspectorField>
            <InspectorField label="Adjustments">{money(inspecting.adjustments)}</InspectorField>
            <InspectorField label="Received">{money(inspecting.deposit)}</InspectorField>
            <InspectorField label="Balance">{money(inspecting.balance)}</InspectorField>
          </InspectorSection>
        ) : null}
      </InspectorSheet>

      <SettleDialog row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

export function SettleDialog({
  row,
  onClose,
}: {
  row: PendingCollection | null;
  onClose: () => void;
}) {
  const settle = useSettleCollection();
  const shift = useMyOpenShift();
  const [amount, setAmount] = useState("");
  const [tendered, setTendered] = useState("");
  const [method, setMethod] = useState("cash");
  const [reference, setReference] = useState("");
  /** Guards a second submission of the same collection from a double click. */
  const submitted = useRef<string | null>(null);
  /**
   * One collection intent per opening of this dialog. The server settles the
   * same receipt for any replay of this key, so a retry after a lost response
   * cannot take the money twice — while a genuine second collection of the
   * same amount, from a fresh dialog, still goes through.
   */
  const intentNonce = useRef<string>(crypto.randomUUID());

  const balance = Number(row?.balance ?? 0);
  const openShift = (shift.data as { id?: string } | null) ?? null;
  const isCash = method === "cash";
  const verdict = evaluateCollection({
    balance,
    amount,
    tendered,
    method,
    openShiftId: openShift?.id ?? null,
    pending: settle.isPending,
  });
  const { value, change, overpaid, shortTender, tillMissing, blocked } = verdict;

  const reset = () => {
    setAmount("");
    setTendered("");
    setReference("");
    submitted.current = null;
    // Closing the dialog ends this collection intent; the next one is new money.
    intentNonce.current = crypto.randomUUID();
  };

  return (
    <Dialog
      open={Boolean(row)}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Verify the bill, then collect payment</DialogTitle>
          <DialogDescription>
            Check the charges with the guest before taking money. The payment posts to the
            originating department's bill and the ledger — it is never recorded twice.
          </DialogDescription>
        </DialogHeader>

        {row ? (
          <div className="grid gap-3">
            <div className="rounded-lg border border-border p-3 text-sm">
              <p className="font-medium">{row.reference ?? "Bill"}</p>
              <p className="text-muted-foreground">
                {row.department} · {row.customer ?? "Walk-in"} · balance {money(balance)}
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="collect-amount">Amount received</Label>
              <Input
                id="collect-amount"
                inputMode="decimal"
                placeholder={String(balance)}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-describedby={overpaid ? "collect-amount-error" : undefined}
                aria-invalid={overpaid || undefined}
              />
              {overpaid ? (
                <p id="collect-amount-error" className="text-xs text-destructive">
                  More than the outstanding balance. An overpayment needs an approved refund or bill
                  adjustment instead.
                </p>
              ) : null}
            </div>

            <div className="grid gap-1.5">
              <PaymentMethodPicker methods={METHODS} value={method} onChange={setMethod} />
            </div>

            {isCash ? (
              <div className="grid gap-1.5">
                <Label htmlFor="collect-tendered">Cash tendered</Label>
                <Input
                  id="collect-tendered"
                  inputMode="decimal"
                  placeholder={String(value || balance)}
                  value={tendered}
                  onChange={(e) => setTendered(e.target.value)}
                  aria-describedby="collect-change"
                  aria-invalid={shortTender || undefined}
                />
                <p
                  id="collect-change"
                  className={
                    shortTender ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                  }
                >
                  {shortTender
                    ? "Less than the amount being collected — take the full amount or reduce it."
                    : `Change due ${money(change)}`}
                </p>
              </div>
            ) : null}

            <div className="grid gap-1.5">
              <Label htmlFor="collect-reference">
                Reference (transaction code, card slip, cheque)
              </Label>
              <Input
                id="collect-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
              />
            </div>

            {tillMissing ? (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
                No till is open for you. Open your cashier session before taking cash, so the
                collection has one collector and the count reconciles at end of shift.
              </p>
            ) : null}

            <Button
              disabled={blocked}
              onClick={() => {
                const key = collectionKey(row.source, row.source_id, value);
                if (submitted.current === key) return;
                submitted.current = key;
                settle.mutate(
                  {
                    source: row.source,
                    source_id: row.source_id,
                    amount: value,
                    tendered: isCash && tendered ? Number(tendered) : null,
                    method,
                    reference,
                    shift_id: openShift?.id ?? null,
                    intent_key: `collect:${key}:${intentNonce.current}`,
                  },
                  {
                    onSuccess: () => {
                      reset();
                      onClose();
                    },
                    // A failed collection stays on the queue and may be retried.
                    onError: () => {
                      submitted.current = null;
                    },
                  },
                );
              }}
            >
              {settle.isPending ? "Collecting…" : "Collect and issue receipt"}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
