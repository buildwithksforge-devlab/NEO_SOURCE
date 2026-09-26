import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { OpsGuard } from "@/components/operations/OpsShared";
import { Banknote, Coins, Wallet } from "lucide-react";
import { PageHeader, SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
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
import { FinanceEmpty, financeHead } from "@/components/finance/FinanceShared";
import { CashRequestInbox } from "@/components/finance/CashRequestInbox";
import { CashTransfersCard } from "@/components/finance/CashTransfersCard";
import { CashRefundsCard } from "@/components/finance/CashRefundsCard";
import { ShiftReconciliationCard } from "@/components/finance/ShiftReconciliationCard";
import { RiderCashCard } from "@/components/delivery/RiderCashCard";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { money, titleCase } from "@/lib/finance";
import { useMyOpenShift } from "@/lib/pos-data";
import {
  useCloseCashShift,
  useOpenCashShift,
  useRecordCashMovement,
  useShiftExpected,
  useShiftMovements,
} from "@/lib/frontdesk-ops";

export const Route = createFileRoute("/_shell/finance/till")({
  head: financeHead(
    "Cashier Till",
    "Open your till with a counted float, record drops and paid-outs, declare counted cash and close your own session with a full variance explanation.",
  ),
  component: GuardedPage,
});

const MOVEMENT_TYPES = ["drop", "paid-out", "float-top-up"];

function TillPage() {
  const { branchId } = useActivePropertyFilter();
  const mine = useMyOpenShift();
  const shiftId = (mine.data as { id?: string } | null)?.id ?? null;
  const expected = useShiftExpected(shiftId);
  const movements = useShiftMovements(shiftId);
  const openTill = useOpenCashShift();
  const closeTill = useCloseCashShift();
  const record = useRecordCashMovement();

  const [float, setFloat] = useState("");
  const [counted, setCounted] = useState("");
  const [reason, setReason] = useState("");
  const [type, setType] = useState("drop");
  const [amount, setAmount] = useState("");
  const [movementReason, setMovementReason] = useState("");

  const session = mine.data as {
    id: string;
    opened_at: string;
    opening_float: number | null;
    shift_number?: string | null;
  } | null;
  const expectedCash = expected.data === undefined ? null : Number(expected.data);
  const variance = expectedCash !== null && counted !== "" ? Number(counted) - expectedCash : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Finance"
        title="Cashier Till"
        description="One open till per cashier. Expected cash is derived from posted payments less drops and paid-outs, so a difference can never be closed silently — it is declared, explained and reviewed independently."
      />

      {session ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard
              label="Opening float"
              value={money(session.opening_float ?? 0)}
              icon={Coins}
            />
            <StatCard
              label="Expected cash now"
              value={expectedCash === null ? "Calculating…" : money(expectedCash)}
              icon={Banknote}
            />
            <StatCard
              label="Variance if closed now"
              value={variance === null ? "—" : money(variance)}
              tone={variance !== null && Math.abs(variance) > 0.009 ? "warning" : "default"}
              icon={Wallet}
            />
          </div>

          <CashRequestInbox />

          <CashTransfersCard branchId={branchId} />

          <CashRefundsCard branchId={branchId} />

          {/* Cash a rider collected on delivery is counted by the cashier, on
              the cashier's own till, never by the rider who carried it. */}
          <RiderCashCard />

          <ShiftReconciliationCard shiftId={session.id} />



          <SectionCard
            title="Record a cash movement"
            description="Every drop to the safe, paid-out and float top-up is recorded against this session with a reason."
          >
            <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
              <div className="grid gap-1.5">
                <Label>Type</Label>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MOVEMENT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {titleCase(t.replace(/[-_]/g, " "))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="movement-amount">Amount</Label>
                <Input
                  id="movement-amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="movement-reason">Reason</Label>
                <Input
                  id="movement-reason"
                  value={movementReason}
                  onChange={(e) => setMovementReason(e.target.value)}
                />
              </div>
              <Button
                disabled={
                  amount === "" ||
                  Number(amount) <= 0 ||
                  movementReason.trim().length < 3 ||
                  record.isPending
                }
                onClick={() =>
                  record.mutate(
                    {
                      shift: session.id,
                      type,
                      amount: Number(amount),
                      reason: movementReason,
                      reference: "",
                    },
                    {
                      onSuccess: () => {
                        setAmount("");
                        setMovementReason("");
                      },
                    },
                  )
                }
              >
                Record movement
              </Button>
            </div>

            <div className="mt-4">
              {(movements.data ?? []).length === 0 ? (
                <FinanceEmpty
                  title="No movements recorded"
                  description="Drops, paid-outs and float top-ups for this session will appear here."
                />
              ) : (
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Recorded</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(movements.data ?? []).map((row) => {
                        const m = row as unknown as {
                          id: string;
                          created_at: string;
                          movement_type: string;
                          amount: number;
                          reason: string | null;
                        };
                        return (
                          <TableRow key={m.id}>
                            <TableCell>{new Date(m.created_at).toLocaleString()}</TableCell>
                            <TableCell>
                              {titleCase(String(m.movement_type).replace(/[-_]/g, " "))}
                            </TableCell>
                            <TableCell className="text-right">{money(m.amount)}</TableCell>
                            <TableCell className="text-muted-foreground">
                              {m.reason ?? "—"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableScroll>
              )}
            </div>
          </SectionCard>

          <SectionCard
            title="Declare and close"
            description="Declare the cash you physically counted. A difference must be explained and is reviewed by someone other than you."
          >
            <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
              <div className="grid gap-1.5">
                <Label htmlFor="counted-cash">Counted cash</Label>
                <Input
                  id="counted-cash"
                  inputMode="decimal"
                  value={counted}
                  onChange={(e) => setCounted(e.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="variance-reason">Variance explanation</Label>
                <Input
                  id="variance-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={variance ? "Required" : "Not required when balanced"}
                />
              </div>
              <Button
                disabled={
                  counted === "" ||
                  Number(counted) < 0 ||
                  closeTill.isPending ||
                  (variance !== null && Math.abs(variance) > 0.009 && reason.trim().length < 3)
                }
                onClick={() =>
                  closeTill.mutate(
                    { shift: session.id, counted: Number(counted), reason },
                    {
                      onSuccess: () => {
                        setCounted("");
                        setReason("");
                      },
                    },
                  )
                }
              >
                Close my till
              </Button>
            </div>
          </SectionCard>
        </>
      ) : (
        <SectionCard
          title="Open your till"
          description="Count your opening float in front of the person handing it over. The declared float is the starting point for the whole session."
        >
          <div className="grid gap-3 sm:grid-cols-3 sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="opening-float">Opening float</Label>
              <Input
                id="opening-float"
                inputMode="decimal"
                value={float}
                onChange={(e) => setFloat(e.target.value)}
              />
            </div>
            <Button
              disabled={float === "" || openTill.isPending}
              onClick={() =>
                openTill.mutate(
                  { branch: branchId ?? null, station: null, float: Number(float) },
                  { onSuccess: () => setFloat("") },
                )
              }
            >
              Open till
            </Button>
          </div>
        </SectionCard>
      )}
    </div>
  );
}

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/finance/till">
      <TillPage />
    </OpsGuard>
  );
}
