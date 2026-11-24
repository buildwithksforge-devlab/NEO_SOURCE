import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRemoveMenuItem } from "@/lib/pos-data";
export function RemoveMenuItemDialog({
  item,
  open,
  onOpenChange,
  onRemoved,
}: {
  item: { id: string; name: string; publish_status: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void;
}) {
  const [mode, setMode] = useState<"archive" | "delete-draft">("archive"),
    [reason, setReason] = useState(""),
    [error, setError] = useState<string | null>(null);
  const remove = useRemoveMenuItem();
  useEffect(() => {
    if (open) {
      setMode("archive");
      setReason("");
      setError(null);
    }
  }, [open, item.id]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {item.name}</DialogTitle>
          <DialogDescription>
            Archive stops future sales and preserves the item and its history. Permanent deletion is
            limited to an unused, unpublished draft without linked records.
          </DialogDescription>
        </DialogHeader>
        <Select value={mode} onValueChange={(v) => setMode(v as "archive" | "delete-draft")}>
          <SelectTrigger aria-label="Removal mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="archive">Archive and retain history</SelectItem>
            {item.publish_status === "draft" ? (
              <SelectItem value="delete-draft">Delete unused draft</SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        <Input
          aria-label="Removal reason"
          placeholder="Reason for removal"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!reason.trim() || remove.isPending}
            onClick={async () => {
              setError(null);
              try {
                await remove.mutateAsync({ id: item.id, mode, reason });
                onOpenChange(false);
                onRemoved();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Removal failed.");
              }
            }}
          >
            {mode === "archive" ? "Archive item" : "Delete unused draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
