import { useId, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirmDelivery } from "@/lib/delivery-data";
import { normalisePaymentMethod } from "@/lib/payment-methods";

export function RiderHandoverForm({ orderId, paymentMethod }: { orderId: string; paymentMethod: string }) {
  const id = useId();
  const confirm = useConfirmDelivery();
  const [pin, setPin] = useState("");
  const [recipient, setRecipient] = useState("");
  const [cash, setCash] = useState("");
  const isCash = normalisePaymentMethod(paymentMethod) === "cash";
  const cashValue = cash.trim();
  const hasCash = isCash && cashValue.length > 0;
  const invalidCash = hasCash && (
    !/^(?:\d+|\d*\.\d{1,2})$/.test(cashValue) || !Number.isFinite(Number(cashValue))
  );
  const invalidHandover = !recipient.trim() || (pin.length > 0 && pin.length < 4) || invalidCash;

  return (
    <form
      aria-labelledby={`${id}-title`}
      className="mt-4 grid gap-4 rounded-2xl bg-slate-50 p-4 text-slate-900"
      onSubmit={(event) => {
        event.preventDefault();
        if (invalidHandover || confirm.isPending || confirm.isSuccess) return;
        confirm.mutate({
          orderId,
          pin,
          recipient: recipient.trim(),
          ...(hasCash ? { cash: Number(cashValue) } : {}),
        });
      }}
    >
      <h3 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="size-5" aria-hidden /> Delivery handover
      </h3>
      <fieldset disabled={confirm.isPending || confirm.isSuccess} className="grid min-w-0 gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-pin`}>Customer PIN</Label>
          <Input id={`${id}-pin`} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric" maxLength={6} aria-describedby={`${id}-pin-help`} autoComplete="off" />
          <p id={`${id}-pin-help`} className="text-xs leading-relaxed text-slate-600">
            Ask the customer for the PIN on their order. Leave it blank only if dispatch has authorised the handover without it.
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-recipient`}>Received by</Label>
          <Input id={`${id}-recipient`} value={recipient} onChange={(event) => setRecipient(event.target.value)} required />
        </div>
        {isCash ? (
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-cash`}>Cash collected</Label>
            <Input id={`${id}-cash`} value={cash} onChange={(event) => setCash(event.target.value)}
              inputMode="decimal" aria-invalid={invalidCash} aria-describedby={invalidCash ? `${id}-cash-error` : undefined} />
            {invalidCash ? <p id={`${id}-cash-error`} className="text-xs text-red-800">Enter a non-negative amount with up to two decimal places.</p> : null}
          </div>
        ) : null}
        <button type="submit" disabled={invalidHandover}
          className="neo-commerce-primary w-full">
          {confirm.isPending ? "Confirming…" : confirm.isSuccess ? "Delivery confirmed" : "Confirm delivery"}
        </button>
      </fieldset>
      {confirm.isError ? <p role="alert" className="text-sm text-red-800">{confirm.error.message}</p> : null}
    </form>
  );
}
