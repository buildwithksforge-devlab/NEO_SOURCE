import { useState } from "react";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/lib/auth";
import { useRevertCheckIn } from "@/lib/pms-data";

/**
 * Undo an accidental check-in. The reason is mandatory and lands in the audit
 * trail; the database refuses the revert once the folio carries posted charges.
 */
export function RevertCheckInDialog({
  reservationId,
  confirmation,
}: {
  reservationId: string;
  confirmation: string;
}) {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const revert = useRevertCheckIn();

  if (!can("pms", "in-house", "edit") && !can("pms", "arrivals", "edit")) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Undo2 className="mr-2 size-4" /> Revert check-in
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revert check-in — {confirmation}</DialogTitle>
          <DialogDescription>
            The stay and its empty folio are removed, the reservation returns to confirmed, and the room goes back to
            vacant. This is refused if any charge has already been posted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Reason (required)</Label>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this arrival being undone?"
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!reason.trim() || revert.isPending}
            onClick={() =>
              revert.mutate(
                { reservation: reservationId, reason: reason.trim() },
                {
                  onSuccess: () => {
                    setReason("");
                    setOpen(false);
                  },
                },
              )
            }
          >
            Revert check-in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
