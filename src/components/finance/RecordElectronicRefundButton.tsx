import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ReceivingAccountSelect } from "@/components/payments/ReceivingAccountSelect";
import { useAuth } from "@/lib/auth";
import { useRecordElectronicRefund } from "@/lib/pos-refunds";
export function RecordElectronicRefundButton({
  requestId,
  branchId,
  originalAccountId,
}: {
  requestId: string;
  branchId: string | null;
  originalAccountId: string | null;
}) {
  const { can, isAdmin } = useAuth();
  const save = useRecordElectronicRefund();
  const [open, setOpen] = useState(false),
    [reference, setReference] = useState(""),
    [account, setAccount] = useState<string | null>(originalAccountId),
    [completed, setCompleted] = useState(false),
    [problem, setProblem] = useState<string | null>(null);
  if (!isAdmin && !can("finance", "payments", "refund_payment")) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          setOpen(true);
          setProblem(null);
          setReference("");
          setAccount(originalAccountId);
          setCompleted(false);
        }}
      >
        Record completed electronic refund
      </Button>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!save.isPending) setOpen(v);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a completed bank/provider refund</DialogTitle>
            <DialogDescription>
              Complete the return through the original bank, terminal or M-PESA channel first.
              Record its confirmation here so NEØ can save the refund receipt and journal. This form
              records the completed return.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Label htmlFor="refund-confirmation">Bank/provider refund confirmation reference</Label>
            <Input
              id="refund-confirmation"
              value={reference}
              disabled={save.isPending}
              onChange={(e) => setReference(e.target.value)}
            />
            <ReceivingAccountSelect
              value={account}
              onChange={setAccount}
              branchId={branchId}
              requireExplicit
              label="Original refund account"
              hint="Use the original receiving account and its configured ledger mapping. Card refunds follow the configured card-clearing account."
              disabled={save.isPending || Boolean(originalAccountId)}
            />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={completed}
                disabled={save.isPending}
                onChange={(e) => setCompleted(e.target.checked)}
              />
              <span>I verified that the bank/provider completed this refund.</span>
            </label>
          </div>
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" disabled={save.isPending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={save.isPending || !completed || reference.trim().length < 3 || !account}
              onClick={async () => {
                if (!account) return;
                try {
                  setProblem(null);
                  await save.mutateAsync({
                    requestId,
                    reference: reference.trim(),
                    accountId: account,
                    completed,
                  });
                  setOpen(false);
                } catch (e) {
                  setProblem(
                    e instanceof Error ? e.message : "Completed refund could not be saved.",
                  );
                }
              }}
            >
              {save.isPending ? "Verifying and recording…" : "Record verified refund"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
