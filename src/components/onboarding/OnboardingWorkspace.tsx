import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The canonical onboarding workspace shell.
 *
 * Every onboarding adapter — Assets, Inventory Items, Employees, Rooms,
 * Suppliers and every adapter added later — renders inside this one shell, so
 * the way onboarding *behaves* is implemented once and inherited everywhere.
 *
 * The layout is deliberately boring and robust, because the defect this
 * replaces was subtle: a Radix ScrollArea was used as the body of a flex
 * column whose height is resolved by the flex algorithm. Its viewport is
 * `h-full`, which resolves against an auto-height parent, so once the content
 * grew past the visible area it was *clipped* by the scroll root instead of
 * scrolled — the administrator could see that more rows existed and could not
 * reach them. That happened at 29 values in Inventory Items and would happen
 * at any size, in any adapter, in any workspace.
 *
 * The rules this shell guarantees:
 *  - the surface is bounded by the viewport (dvh, so mobile browser chrome
 *    cannot push the footer off-screen),
 *  - the header and the action footer never scroll away,
 *  - exactly one element scrolls — the body — using native overflow, which
 *    cannot clip,
 *  - the footer sits above the body, so no content ever hides beneath it,
 *  - nothing is nested inside a second scroll container, so there is no
 *    scroll trap.
 */
export function OnboardingWorkspace({
  open,
  onOpenChange,
  title,
  description,
  steps,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  steps?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-onboarding-shell="workspace"
        className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[94dvh] sm:max-h-[94dvh] sm:w-[calc(100vw-2rem)] sm:max-w-[1400px] sm:rounded-2xl"
      >
        <DialogHeader
          data-onboarding-shell="header"
          className="shrink-0 space-y-1.5 border-b border-border px-4 py-4 sm:px-6"
        >
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
          {steps ? <div className="mt-2 flex flex-wrap gap-1.5">{steps}</div> : null}
        </DialogHeader>

        {/* The single scrolling region. Native overflow, never a scroll
            primitive that depends on a resolved parent height. */}
        <div
          data-onboarding-shell="body"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          <div className="space-y-5 px-4 py-5 sm:px-6">{children}</div>
        </div>

        {footer ? (
          <div
            data-onboarding-shell="footer"
            className="shrink-0 border-t border-border bg-background px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-4"
          >
            {footer}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A bounded table region for a long list inside the workspace body.
 *
 * Horizontal overflow is intentional and local; vertical scrolling stays with
 * the workspace body so a table can never become a scroll trap of its own.
 */
export function OnboardingTableFrame({ children }: { children: ReactNode }) {
  return (
    <div
      data-onboarding-shell="table"
      className="w-full max-w-full overflow-x-auto rounded-lg border border-border"
    >
      {children}
    </div>
  );
}
