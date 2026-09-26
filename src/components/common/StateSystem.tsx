/**
 * The NEØ state language.
 *
 * Every screen in the product answers the same six questions the same way, so
 * a user never meets a bare sentence floating in white space:
 *
 *   loading   — skeletons shaped like the content that is coming
 *   empty     — what would normally be here, plus a CTA only if they can act
 *   error     — a contained destructive-tinted card with a safe message
 *   setup     — a calm informational card naming the missing configuration
 *   denied    — a neutral locked card with no misleading retry/configure action
 *   offline   — a quiet card offering a retry
 *
 * Module shells (PMS, Ops, POS, Kitchen, HR, Bar, Finance, Delivery,
 * Analytics, Marketing, Platform, dashboards …) re-export these, so the whole
 * staff app inherits the language without restyling individual routes.
 */
import type { ReactNode } from "react";
import {
  AlertTriangle,
  Inbox,
  Info,
  Lock,
  RefreshCw,
  Settings2,
  WifiOff,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export type StateVariant = "loading" | "empty" | "error" | "setup" | "denied" | "offline";

type VariantStyle = {
  icon: LucideIcon;
  /** Icon disc — a soft semantic tint, never a harsh black pill. */
  disc: string;
  /** Container edge/wash. */
  shell: string;
};

const VARIANT: Record<Exclude<StateVariant, "loading">, VariantStyle> = {
  empty: {
    icon: Inbox,
    disc: "bg-muted text-muted-foreground",
    shell: "border-dashed border-border/70 bg-card/40",
  },
  error: {
    icon: AlertTriangle,
    disc: "bg-destructive/12 text-destructive",
    shell: "border-destructive/35 bg-destructive/[0.04]",
  },
  setup: {
    icon: Settings2,
    disc: "bg-warning/18 text-on-tint-warning",
    shell: "border-warning/35 bg-warning/[0.06]",
  },
  denied: {
    icon: Lock,
    disc: "bg-muted text-muted-foreground",
    shell: "border-border/70 bg-muted/25",
  },
  offline: {
    icon: WifiOff,
    disc: "bg-info/15 text-info",
    shell: "border-info/30 bg-info/[0.05]",
  },
};

/**
 * Database internals never reach an operator. Column names, relation names,
 * policy text and driver noise are replaced by one honest sentence; the raw
 * text stays in the console for engineers.
 */
const RAW_DB_SIGNALS = [
  /column\s+[\w".]+\s+does not exist/i,
  /relation\s+"?[\w.]+"?\s+does not exist/i,
  /permission denied for (table|relation|function|schema)/i,
  /violates (row-level security|foreign key|unique|check) /i,
  /function\s+[\w.]+\([^)]*\)\s+does not exist/i,
  /invalid input syntax for type/i,
  /duplicate key value/i,
  /^PGRST\d+/i,
  /JWT|jwt expired/i,
  /syntax error at or near/i,
];

export function sanitizeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error && "message" in error
          ? String((error as { message: unknown }).message)
          : "";
  const message = raw.trim();
  if (!message) return "This data could not be loaded right now.";
  if (RAW_DB_SIGNALS.some((pattern) => pattern.test(message))) {
    return "This data could not be loaded. The workspace has reported a technical fault — please retry, and report the problem if it persists.";
  }
  // Long stack-ish payloads are noise to an operator.
  if (message.length > 180) return "This data could not be loaded right now. Please retry.";
  return message;
}

export type StateCardProps = {
  variant: Exclude<StateVariant, "loading">;
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
  /** Compact form for inline use inside a table cell or narrow panel. */
  inline?: boolean;
  className?: string;
};

/**
 * The single contained surface behind every non-loading state. It always sits
 * inside its parent panel, wraps its explanation and keeps its title on one
 * line, so it can never push a page into horizontal overflow.
 */
export function StateCard({
  variant,
  title,
  description,
  icon,
  action,
  inline,
  className,
}: StateCardProps) {
  const style = VARIANT[variant];
  const Icon = icon ?? style.icon;

  if (inline) {
    return (
      <div
        data-state-card={variant}
        className={cn(
          "flex w-full min-w-0 items-start gap-3 rounded-xl border p-4 text-left",
          style.shell,
          className,
        )}
      >
        <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg", style.disc)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="neo-line-1 text-sm font-semibold text-foreground" title={title}>
            {title}
          </p>
          {description ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
          {action ? <div className="mt-3 flex flex-wrap items-center gap-2">{action}</div> : null}
        </div>
      </div>
    );
  }

  return (
    <div
      data-state-card={variant}
      className={cn(
        "flex w-full min-w-0 flex-col items-center gap-3 rounded-2xl border px-5 py-10 text-center sm:px-8 sm:py-12",
        style.shell,
        className,
      )}
    >
      <span className={cn("flex size-12 items-center justify-center rounded-2xl", style.disc)}>
        <Icon className="size-5" />
      </span>
      <p className="neo-line-1 max-w-full text-sm font-semibold text-foreground" title={title}>
        {title}
      </p>
      {description ? (
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** Skeletons shaped like the content, never a full-panel spinner. */
export function LoadingState({
  rows = 3,
  variant = "rows",
  className,
}: {
  rows?: number;
  variant?: "rows" | "cards" | "table";
  className?: string;
}) {
  if (variant === "cards") {
    return (
      <div data-state-card="loading" className={cn("neo-metric-grid", className)}>
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-2xl" />
        ))}
      </div>
    );
  }
  if (variant === "table") {
    return (
      <div data-state-card="loading" className={cn("space-y-2", className)}>
        <Skeleton className="h-9 w-full rounded-lg" />
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  return (
    <div data-state-card="loading" className={cn("space-y-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton
          key={i}
          className={cn("h-10 w-full rounded-lg", i === rows - 1 && "w-2/3")}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  inline,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: LucideIcon;
  inline?: boolean;
  className?: string;
}) {
  return (
    <StateCard
      variant="empty"
      title={title}
      {...(description ? { description } : {})}
      {...(icon ? { icon } : {})}
      {...(action ? { action } : {})}
      {...(inline ? { inline } : {})}
      {...(className ? { className } : {})}
    />
  );
}

export function ErrorState({
  error,
  title = "This data could not be loaded",
  onRetry,
  inline,
  className,
}: {
  error?: unknown;
  title?: string;
  onRetry?: () => void;
  inline?: boolean;
  className?: string;
}) {
  return (
    <StateCard
      variant="error"
      title={title}
      description={sanitizeErrorMessage(error)}
      {...(inline ? { inline } : {})}
      {...(className ? { className } : {})}
      {...(onRetry
        ? {
            action: (
              <Button size="sm" variant="outline" onClick={onRetry}>
                <RefreshCw className="mr-2 size-3.5" />
                Retry
              </Button>
            ),
          }
        : {})}
    />
  );
}

/**
 * Setup required. The Configure action only appears when the caller confirms
 * the account may actually perform the configuration.
 */
export function NotConfiguredState({
  feature,
  detail,
  action,
  inline,
  className,
}: {
  feature: string;
  detail?: string;
  action?: ReactNode;
  inline?: boolean;
  className?: string;
}) {
  return (
    <StateCard
      variant="setup"
      title={`${feature} — Not Configured`}
      description={
        detail ??
        "No verified configuration exists yet, so nothing is shown, sent or estimated here. An administrator must complete the setup."
      }
      {...(action ? { action } : {})}
      {...(inline ? { inline } : {})}
      {...(className ? { className } : {})}
    />
  );
}

/** Locked, neutral, and deliberately actionless — retrying cannot help. */
export function NotAuthorisedState({
  subject,
  detail,
  inline,
  className,
}: {
  subject: string;
  detail?: string;
  inline?: boolean;
  className?: string;
}) {
  return (
    <StateCard
      variant="denied"
      title="Access not permitted"
      description={
        detail ??
        `Your roles do not include access to ${subject}. Ask an administrator to grant this permission if you need it for your work.`
      }
      {...(inline ? { inline } : {})}
      {...(className ? { className } : {})}
    />
  );
}

export function OfflineState({ onRetry, inline }: { onRetry?: () => void; inline?: boolean }) {
  return (
    <StateCard
      variant="offline"
      title="Working offline"
      description="This device has lost its connection to the workspace. Records will load again once the connection returns."
      {...(inline ? { inline } : {})}
      {...(onRetry
        ? {
            action: (
              <Button size="sm" variant="outline" onClick={onRetry}>
                <RefreshCw className="mr-2 size-3.5" />
                Retry
              </Button>
            ),
          }
        : {})}
    />
  );
}

/**
 * The orchestration every list and panel uses: loading → error → empty →
 * content, with one consistent presentation for each branch.
 */
export type SettleableQuery = {
  isPending?: boolean;
  isFetching?: boolean;
  isFetched?: boolean;
  error?: unknown;
};

/**
 * Has this query actually answered yet?
 *
 * `isLoading` alone is not enough: a query that is still waiting for its
 * enabling condition (a resolved property, a signed-in session) is pending but
 * not fetching, so a screen that trusts `isLoading` renders "0 records" and
 * then silently replaces it with the truth a moment later. A screen may only
 * conclude "none" once the query has genuinely settled.
 */
export function querySettled(query: SettleableQuery | undefined): boolean {
  if (!query) return true;
  if (query.error) return true;
  if (query.isFetched) return true;
  return query.isPending === false && query.isFetching === false;
}

export function QueryState({
  isLoading,
  error,
  isEmpty,
  empty,
  onRetry,
  query,
  skeleton = "rows",
  skeletonRows = 3,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  isEmpty: boolean;
  empty: ReactNode;
  onRetry?: () => void;
  /**
   * The query itself, when the caller has it. Passing it lets this component
   * hold back an empty-state conclusion until the query has settled.
   */
  query?: SettleableQuery;
  skeleton?: "rows" | "cards" | "table";
  skeletonRows?: number;
  children: ReactNode;
}) {
  if (isLoading || (isEmpty && !error && !querySettled(query)))
    return <LoadingState variant={skeleton} rows={skeletonRows} />;
  if (error) {
    if (import.meta.env.DEV) console.error("[NEØ query]", error);
    return <ErrorState error={error} inline {...(onRetry ? { onRetry } : {})} />;
  }
  if (isEmpty) return <>{empty}</>;
  return <>{children}</>;
}

export const StateSystemIcons = { Info };
