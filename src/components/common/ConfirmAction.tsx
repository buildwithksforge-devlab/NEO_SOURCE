import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

/**
 * One confirmation surface for the whole workspace.
 *
 * Every action that removes, retires or reverses a record asks in the same
 * words and in the same shape, so an operator never has to guess what a
 * confirmation is about:
 *
 *   • the title names the action;
 *   • the body names the exact record, by the name the operator sees in the
 *     list, and spells out what happens to anything attached to it;
 *   • the confirm button repeats the verb rather than saying "OK", so the
 *     button itself is never the ambiguous part;
 *   • destructive confirmations are styled as destructive, reversible ones
 *     (deactivate, archive, retire) are not — the colour carries meaning.
 *
 * Nothing here decides *whether* an action is allowed. Permission is resolved
 * by the caller and the control is simply absent when the account may not act.
 */
export type ConfirmActionProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Delete supplier", "Deactivate store" — the verb the button repeats. */
  title: string;
  /** The record this will affect, named as the operator sees it in the list. */
  recordName?: string | undefined;
  /** What happens, and to what. Written for someone who has to be sure. */
  description: ReactNode;
  /** Extra consequence lines: what else is attached to this record. */
  impact?: ReactNode | undefined;
  confirmLabel: string;
  cancelLabel?: string | undefined;
  /** True for irreversible removal, false for retire/deactivate/archive. */
  destructive?: boolean | undefined;
  pending?: boolean | undefined;
  onConfirm: () => void;
};

export function ConfirmAction({
  open,
  onOpenChange,
  title,
  recordName,
  description,
  impact,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  onConfirm,
}: ConfirmActionProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <AlertDialogContent className="max-h-[85vh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">
              {recordName ? (
                <p className="font-medium text-foreground break-words">{recordName}</p>
              ) : null}
              <div>{description}</div>
              {impact ? <div className="text-xs">{impact}</div> : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={(event) => {
              // The dialog stays open while the write is in flight so the
              // operator sees the outcome rather than a silently closed sheet.
              event.preventDefault();
              onConfirm();
            }}
            className={cn(
              destructive && "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            )}
          >
            {pending ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Small helper for pages that own a single confirm dialog at a time. */
export function useConfirmTarget<T>() {
  const [target, setTarget] = useState<T | null>(null);
  return {
    target,
    open: target !== null,
    ask: (next: T) => setTarget(next),
    close: () => setTarget(null),
  };
}
