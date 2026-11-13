import { useRef, useState, type ReactNode } from "react";

/** Stock failures go to the bill's inline error area; selection never opens another dialog. */
export function StockAwareMenuItem({ name, disabled, unavailableReason, checkStock, onAvailable, onUnavailable, children }: {
  name: string;
  disabled: boolean;
  unavailableReason?: string | null;
  checkStock: () => Promise<string | null>;
  onAvailable: () => void;
  onUnavailable: (reason: string) => void;
  children: ReactNode;
}) {
  const lock = useRef(false);
  const [checking, setChecking] = useState(false);
  const select = async () => {
    if (disabled || lock.current) return;
    lock.current = true; setChecking(true);
    try {
      const currentReason = await checkStock();
      const blocked = currentReason || unavailableReason;
      if (blocked) onUnavailable(blocked);
      else onAvailable();
    } catch {
      onUnavailable("Stock availability could not be verified. Refresh and try again; this selection was not added.");
    } finally {
      lock.current = false; setChecking(false);
    }
  };
  return (
    <button type="button" aria-label={name} disabled={disabled || checking} aria-busy={checking}
      title={unavailableReason || undefined} onClick={() => void select()}
      className="rounded-xl border border-border bg-card p-3 text-left transition-shadow hover:shadow-lift disabled:opacity-50">
      {children}
    </button>
  );
}
