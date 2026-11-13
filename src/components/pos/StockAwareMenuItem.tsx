import { useRef, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** An unavailable item opens its actual stock explanation, never the add-to-bill dialog. */
export function StockAwareMenuItem({ name, disabled, unavailableReason, checkStock, onAvailable, children }: {
  name: string;
  disabled: boolean;
  unavailableReason?: string | null;
  checkStock: () => Promise<string | null>;
  onAvailable: () => void;
  children: ReactNode;
}) {
  const lock = useRef(false);
  const [checking, setChecking] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const select = async () => {
    if (disabled || lock.current) return;
    lock.current = true; setChecking(true);
    try {
      const currentReason = await checkStock();
      const blocked = currentReason || unavailableReason;
      if (blocked) setReason(blocked);
      else onAvailable();
    } catch {
      setReason("Stock availability could not be verified. Refresh and try again; this selection was not added.");
    } finally {
      lock.current = false; setChecking(false);
    }
  };
  return <>
    <button type="button" disabled={disabled || checking} aria-busy={checking}
      title={unavailableReason || undefined} onClick={() => void select()}
      className="rounded-xl border border-border bg-card p-3 text-left transition-shadow hover:shadow-lift disabled:opacity-50">
      {children}
      {checking ? <span className="text-xs text-muted-foreground">Checking stock…</span> : null}
    </button>
    <Dialog open={reason !== null} onOpenChange={open => !open && setReason(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{name}: unavailable</DialogTitle>
          <DialogDescription>This selection was not added to the bill.</DialogDescription>
        </DialogHeader>
        <p role="alert" className="text-sm">{reason}</p>
        <Button onClick={() => setReason(null)}>Close</Button>
      </DialogContent>
    </Dialog>
  </>;
}
