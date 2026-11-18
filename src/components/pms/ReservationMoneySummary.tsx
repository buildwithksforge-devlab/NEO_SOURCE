import { SectionCard } from "@/components/common/DataDisplay";
import { moneyWithCode } from "@/lib/pms";
import type { ReservationMoneyPosition } from "@/lib/reservation-money-position";

export function ReservationMoneySummary({position}:{position:ReservationMoneyPosition}) {
  const value=(amount:number)=>moneyWithCode(amount,position.currency);
  const rows=[
    ["Original booking quote",position.quote],
    ["Current booking obligation",position.obligation],
    ["Confirmed money received",position.collected],
    ["Of which deposits (already included)",position.deposit_paid],
    ["Booking amount still due",position.outstanding],
    ["Awaiting confirmation",position.pending],
    ["Available for a new collection",position.headroom],
    ["Booking credit / overpayment",position.credit],
  ] as const;
  return <SectionCard title="Booking money" description="The full booking, including charges that may not yet be posted to a folio.">
    <dl className="space-y-3 text-sm">{rows.map(([label,amount])=><div key={label} className="flex justify-between gap-4 border-b pb-2">
      <dt className="text-muted-foreground">{label}</dt><dd className="text-right font-medium">{value(amount)}</dd>
    </div>)}</dl>
    <p className="mt-3 text-xs text-muted-foreground">Current booking obligation − confirmed money received = amount still due (or a credit).
      Deposits are counted once. Applying a deposit to a folio moves the same money; it is not another receipt.</p>
    <p className="mt-2 text-xs text-muted-foreground">Pending payments have not paid the bill. They reduce the amount available for a new collection to avoid requesting the same money again.
      Posted folio balances below cover charges posted so far and can differ from the full booking.</p>
  </SectionCard>;
}
