import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useVisibility } from "@/lib/visibility";
import { useOptionalAuth } from "@/lib/auth";

type PermittedLinkProps = {
  to: string;
  className?: string | undefined;
  children: ReactNode;
  hideWhenDenied?: boolean | undefined;
  [key: string]: unknown;
};

export function usePagePermitted(): (path: string) => boolean {
  const visibility = useVisibility();

  return (path: string) => visibility.canSeePage(path);
}

function AuthenticatedPermittedLink({
  to,
  className,
  children,
  hideWhenDenied,
  ...rest
}: PermittedLinkProps) {
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

export function PermittedLink({
  to,
  className,
  children,
  hideWhenDenied,
  ...rest
}: PermittedLinkProps) {
  const auth = useOptionalAuth();

  if (!auth) {
    return (
      <Link to={to} className={className} {...(rest as Record<string, never>)}>
        {children}
      </Link>
    );
  }

  return (
    <AuthenticatedPermittedLink
      to={to}
      className={className}
      hideWhenDenied={hideWhenDenied}
      {...rest}
    >
      {children}
    </AuthenticatedPermittedLink>
  );
}