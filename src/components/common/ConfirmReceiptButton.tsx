/**
 * Department-side receipt confirmation.
 *
 * The department that raised a Stores requisition confirms what it actually
 * received. This is the canonical `req_confirm_receipt` engine — it records the
 * receipt against the issued lines and raises a discrepancy for Stores when the
 * received quantity falls short. It never posts a second inventory movement:
 * stock left the store when Stores issued it.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConfirmRequisitionReceipt } from "@/lib/fnb";

type Row = Record<string, unknown>;

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0) || 0);
const str = (v: unknown, fallback = "—") =>
  v === null || v === undefined || v === "" ? fallback : String(v);

/** True when a requisition is issued and therefore awaiting a receipt. */
export function awaitingReceipt(requisition: Row): boolean {
  return String(requisition["status"] ?? "").includes("issued");
}

export function ConfirmReceiptButton({
  requisition,
  label = "Confirm receipt",
}: {
  requisition: Row;
  label?: string;
}) {
  const confirm = useConfirmRequisitionReceipt();
  const [open, setOpen] = useState(false);
  const [received, setReceived] = useState<Record<string, string>>({});

  const lines = (requisition["internal_requisition_lines"] as Row[] | null) ?? [];

  const submit = () => {
    const payload = lines
      .map((l) => ({
        id: String(l["id"]),
        quantity_received: Number(received[String(l["id"])] ?? 0) || 0,
      }))
      .filter((l) => l.quantity_received > 0);
    confirm.mutate(
      { requisitionId: String(requisition["id"]), lines: payload },
      {
        onSuccess: () => {
          setOpen(false);
          setReceived({});
        },
      },
    );
  };

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm what was received</DialogTitle>
            <DialogDescription>
              Anything short of the issued quantity is recorded as a discrepancy for Stores to
              resolve. Stock moved when Stores issued it — confirming receipt never moves it again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This requisition has no issued lines to confirm.
              </p>
            ) : null}
            {lines.map((l) => (
              <div key={String(l["id"])} className="grid gap-2 sm:grid-cols-[2fr_1fr]">
                <div>
                  <p className="text-sm font-medium">{str(l["description"])}</p>
                  <p className="text-xs text-muted-foreground">
                    {`Issued ${num(l["quantity_issued"])} ${str(l["unit"], "")} · received so far ${num(l["quantity_received"])}`}
                  </p>
                </div>
                <Input
                  type="number"
                  min="0"
                  placeholder="Received now"
                  aria-label={`Received now — ${str(l["description"], "line")}`}
                  value={received[String(l["id"])] ?? ""}
                  onChange={(e) =>
                    setReceived((prev) => ({ ...prev, [String(l["id"])]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={confirm.isPending || lines.length === 0}>
              Confirm receipt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
