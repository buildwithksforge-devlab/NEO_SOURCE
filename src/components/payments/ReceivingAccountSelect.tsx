import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useReceivingAccounts } from "@/lib/financial-accounts";

/**
 * Shared "Money received into" picker.
 *
 * The payment method says how the money was paid; this says which of the
 * hotel's own accounts received it. Used by every collection screen so the
 * receipt, journal and ledger all point at the same account.
 */
export function ReceivingAccountSelect({
  value,
  onChange,
  id = "receiving-account",
  label = "Money received into",
  hint,
  disabled,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  id?: string;
  label?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const accounts = useReceivingAccounts();
  const options = accounts.data ?? [];
  // An account with no ledger mapping cannot steer the journal on its own.
  const unmapped = value ? options.find((a) => a.id === value && !a.gl_code) : undefined;

  if (!accounts.isLoading && options.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
        No receiving accounts are set up for this property yet, so the money will follow the account
        normally used for the payment method. Add them under Finance → Banking.
      </p>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? "auto"}
        disabled={disabled || accounts.isLoading}
        onValueChange={(next) => onChange(next === "auto" ? null : next)}
      >
        <SelectTrigger id={id} aria-label={label}>
          <SelectValue placeholder="Choose an account" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">Use the usual account for this method</SelectItem>
          {options.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.name}
              {a.currency ? ` · ${a.currency}` : ""}
              {a.is_default ? " · default" : ""}
              {a.gl_code ? "" : " · no ledger account set"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {hint ?? "Where this money lands. The payment method stays a separate record of how it was paid."}
      </p>
      {unmapped ? (
        <p className="text-xs text-warning">
          {unmapped.name} has no ledger account set yet, so this receipt will follow the usual
          account for the payment method. Set it under Finance → Banking.
        </p>
      ) : null}
    </div>
  );
}
