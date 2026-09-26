import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";

export { EmptyState, QueryState } from "@/components/pms/PmsShared";

/**
 * Gate a Delivery screen on a `delivery` capability. Authority is whatever User
 * Administration granted the role — never the role name.
 */
export function DeliveryGuard({ action, children }: { action: string; children: ReactNode }) {
  const { can, loading } = useAuth();
  if (loading) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (!can("delivery", action)) {
    return (
      <Card className="surface-panel">
        <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
          <span className="rounded-full bg-muted p-3 text-muted-foreground">
            <Lock className="size-5" />
          </span>
          <p className="text-base font-semibold">You do not have access to this Delivery screen</p>
          <p className="max-w-md text-sm text-muted-foreground">
            The <span className="font-mono text-xs">delivery.{action}</span> permission is required. Ask an
            administrator to grant it from Roles &amp; Permissions.
          </p>
          <Link to="/workspace" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Back to dashboard
          </Link>
        </CardContent>
      </Card>
    );
  }
  return <>{children}</>;
}
