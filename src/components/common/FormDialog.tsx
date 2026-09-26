import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared edit/create form shell.
 *
 * One viewport-safe surface for every form in the staff app: the header (with
 * its close affordance) and the action footer stay in place while only the
 * form body scrolls, so a long form never spills through the page or clips its
 * Save button on a phone. Field layout stays with the caller — this shell only
 * owns the surface, scrolling and the action row.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footerNote,
  submitLabel,
  cancelLabel = "Cancel",
  onSubmit,
  canSubmit = true,
  busy = false,
  busyLabel,
  size = "lg",
  extraActions,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footerNote?: ReactNode;
  submitLabel: string;
  cancelLabel?: string;
  onSubmit: () => void;
  canSubmit?: boolean;
  busy?: boolean;
  busyLabel?: string;
  size?: "md" | "lg" | "xl";
  extraActions?: ReactNode;
}) {
  const width = size === "xl" ? "sm:max-w-4xl" : size === "md" ? "sm:max-w-xl" : "sm:max-w-3xl";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(width, "gap-0 overflow-hidden p-0 sm:p-0")}
        data-form-dialog
      >
        <DialogHeader className="border-b border-border/70 px-4 py-4 pr-14 sm:px-6">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <DialogBody className="px-4 py-4 sm:px-6 sm:py-5">
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit && !busy) onSubmit();
            }}
          >
            {children}
            {/* Lets the keyboard "go" action submit without a visible button. */}
            <button type="submit" className="sr-only" tabIndex={-1} aria-hidden />
          </form>
        </DialogBody>

        <DialogFooter className="border-t border-border/70 bg-background/95 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:px-6">
          {footerNote ? (
            <p className="mr-auto min-w-0 text-xs text-muted-foreground sm:max-w-[24rem]">
              {footerNote}
            </p>
          ) : null}
          {extraActions}
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button type="button" disabled={!canSubmit || busy} onClick={onSubmit}>
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                {busyLabel ?? "Saving…"}
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
