import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useVisibility } from "@/lib/visibility";

/**
 * A link the workspace is allowed to offer.
 *
 * Backend enforcement stays mandatory, but the UI must never lead a user into
 * a page their role cannot open. Every dashboard card, quick action, handoff
 * and deep link routes through this component: when the destination fails the
 * same `canSeePage` check the sidebar and route guard apply, the label is
 * rendered as plain text (or hidden entirely) instead of a dead link.
 */
export function usePagePermitted(): (path: string) => boolean {
  // Outside a session context (isolated component tests, a shell that has not
  // hydrated yet) the UI simply does not narrow anything — backend enforcement
  // is unaffected, and no reader is stranded by a missing provider.
  let visibility: ReturnType<typeof useVisibility> | null = null;
  try {
    visibility = useVisibility();
  } catch {
    visibility = null;
  }
  return (path: string) => (visibility ? visibility.canSeePage(path) : true);
}

export function PermittedLink({
  to,
  className,
  children,
  hideWhenDenied,
  ...rest
}: {
  to: string;
  className?: string;
  children: ReactNode;
  hideWhenDenied?: boolean;
  [key: string]: unknown;
}) {
  const permitted = usePagePermitted()(to);
  if (!permitted) {
    if (hideWhenDenied) return null;
    return <span className={className}>{children}</span>;
  }
  return (
    <Link to={to} className={className} {...(rest as Record<string, never>)}>
      {children}
    </Link>
  );
}
