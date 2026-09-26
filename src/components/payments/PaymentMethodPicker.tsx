/**
 * The one payment-method picker.
 *
 * Every screen that collects money uses this, so a method means the same thing
 * everywhere. A provider-backed method (M-Pesa, an integrated terminal, a QR
 * provider) can only be chosen when this workspace's saved configuration says
 * it is ready; when it is not, the picker says why and points to the single
 * place it is set up, instead of letting someone take a payment that nothing
 * will ever confirm.
 */
import { Link } from "@tanstack/react-router";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PAYMENT_METHOD_CATALOGUE,
  usePaymentReadiness,
  type PaymentMethodDefinition,
} from "@/lib/payment-methods";

export function PaymentMethodPicker({
  methods,
  value,
  onChange,
  label = "Method",
}: {
  /** Methods this screen can actually take, in the order to show them. */
  methods: readonly PaymentMethodDefinition[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const readiness = usePaymentReadiness();
  const byMethod = new Map((readiness.data ?? []).map((r) => [r.method, r]));

  const selected = methods.find((m) => m.value === value);
  const state = selected ? byMethod.get(selected.value) : undefined;
  const providerBlocked = Boolean(selected?.provider) && state ? !state.ready : false;

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {methods.map((m) => {
            const r = byMethod.get(m.value);
            const blocked = Boolean(m.provider) && r ? !r.ready : false;
            return (
              <SelectItem key={m.value} value={m.value} disabled={blocked}>
                {m.label}
                {blocked ? " · not set up" : ""}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      {selected ? <p className="text-xs text-muted-foreground">{selected.hint}</p> : null}

      {providerBlocked ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-on-tint-warning">
          {state?.reason ?? "This provider is not set up in this workspace yet."}{" "}
          {selected?.configPath ? (
            <Link to={selected.configPath} className="font-medium underline underline-offset-2">
              Set it up
            </Link>
          ) : null}
        </p>
      ) : null}

      {selected && !selected.provider ? (
        <p className="text-xs text-muted-foreground">
          Recorded tender: the money moves outside NEØ and this entry is the record of it. It is
          marked unverified until someone checks it against the outside evidence.
        </p>
      ) : null}
    </div>
  );
}

/** Picks the given method values out of the one catalogue, in the given order. */
export function methodsFor(values: readonly string[]): PaymentMethodDefinition[] {
  return values.flatMap((v) => PAYMENT_METHOD_CATALOGUE.filter((m) => m.value === v));
}
