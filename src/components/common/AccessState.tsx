import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { ShieldAlert, ArrowLeft, Settings2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * One denied-state vocabulary for the whole product.
 *
 * Sidebar links, module tabs, routes, buttons and forms all refuse for exactly
 * three reasons, and each reason reads the same wherever it appears:
 *
 *   "denied"      — the account genuinely lacks the capability.
 *   "setup"       — the capability exists but the workspace is not configured
 *                   (no property/department/station assignment, missing data).
 *   "scope"       — the capability exists but the record is outside the
 *                   account's personal/station/department/property scope.
 *
 * Never invent new phrasing at the call site: pass a reason and the subject.
 */
export type DeniedReason = "denied" | "setup" | "scope";

export const DENIED_TITLE: Record<DeniedReason, string> = {
  denied: "Access not permitted",
  setup: "Setup Incomplete",
  scope: "Outside your scope",
};

export function deniedMessage(reason: DeniedReason, subject: string): string {
  if (reason === "setup") {
    return `${subject} is not configured for your workspace yet. An administrator must complete the setup before this can be used.`;
  }
  if (reason === "scope") {
    return `${subject} belongs to a property, department or station you are not assigned to. Ask an administrator to extend your assignment if you need it.`;
  }
  return `Your roles do not include access to ${subject}. Ask an administrator to grant this permission if you need it for your work.`;
}

/** Full-page refusal — used by the route guard and by blocked module tabs. */
export function AccessDeniedPanel({
  reason = "denied",
  subject,
  detail,
  action,
  className,
}: {
  reason?: DeniedReason;
  subject: string;
  detail?: string;
  action?: ReactNode;
  className?: string;
}) {
  const Icon = reason === "setup" ? Settings2 : ShieldAlert;
  const tone =
    reason === "setup" ? "bg-warning/15 text-on-tint-warning" : "bg-destructive/10 text-destructive";
  return (
    <div
      data-denied-reason={reason}
      className={cn("mx-auto max-w-xl rounded-2xl border border-border bg-card p-8 text-center", className)}
    >
      <div className={cn("mx-auto mb-4 flex size-12 items-center justify-center rounded-full", tone)}>
        <Icon className="size-6" />
      </div>
      <h1 className="text-lg font-semibold text-foreground">{DENIED_TITLE[reason]}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{deniedMessage(reason, subject)}</p>
      {detail ? <p className="mt-2 text-xs text-muted-foreground">{detail}</p> : null}
      <div className="mt-6 flex justify-center gap-2">
        {action ?? (
          <Button asChild variant="outline">
            <Link to="/workspace">
              <ArrowLeft className="mr-2 size-4" />
              Back to workspace
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/** Inline refusal for an area of a page (a tab body, a card, a form section). */
export function AccessDeniedInline({
  reason = "denied",
  subject,
}: {
  reason?: DeniedReason;
  subject: string;
}) {
  return (
    <div
      data-denied-reason={reason}
      className="flex items-start gap-3 rounded-xl border border-dashed border-border bg-muted/30 p-4 text-left"
    >
      <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div>
        <p className="text-sm font-medium text-foreground">{DENIED_TITLE[reason]}</p>
        <p className="mt-1 text-xs text-muted-foreground">{deniedMessage(reason, subject)}</p>
      </div>
    </div>
  );
}

/**
 * A control the account may see but not use. Keeping the control visible and
 * explaining the refusal beats hiding it silently — the user learns what to
 * request. Pass `hidden` when the control must not be advertised at all.
 */
export function GuardedAction({
  allowed,
  reason = "denied",
  subject,
  hidden,
  children,
}: {
  allowed: boolean;
  reason?: DeniedReason;
  subject: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  if (allowed) return <>{children}</>;
  if (hidden) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-denied-reason={reason}
          className="inline-flex cursor-not-allowed opacity-50 [&_*]:pointer-events-none"
          aria-disabled="true"
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <span className="text-xs">
          <strong>{DENIED_TITLE[reason]}.</strong> {deniedMessage(reason, subject)}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
