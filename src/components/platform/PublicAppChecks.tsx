import { Link } from "@tanstack/react-router";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { TonePill, formatDateTime } from "@/components/platform/PlatformShared";
import { usePublicAppHealth } from "@/lib/platform-public-app-health";
import { useAuth } from "@/lib/auth";
import { canAccessPath } from "@/lib/nav-permissions";

export function PublicAppChecks() {
  const checks = usePublicAppHealth();
  const { can } = useAuth();
  if (!checks.allowed) return null;

  return (
    <SectionCard title="Public app checks" description="Checks the published property and build from a signed-out page request. Checkout needs its own evidence."
      actions={checks.branchId ? <Button size="sm" variant="outline" disabled={checks.isFetching} onClick={() => void checks.refetch()}>Recheck links</Button> : undefined}>
      {!checks.branchId ? <p className="text-sm text-muted-foreground">Select a property to check its Guest and Delivery links.</p>
        : checks.isError ? <p className="text-sm text-destructive" role="alert">{checks.error.message}</p>
        : checks.isPending ? <p className="text-sm text-muted-foreground" role="status">Checking public links…</p>
        : <ul className="divide-y">
          {checks.data.map((check) => (
            <li key={check.app} className="grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">{check.app === "delivery" ? "Delivery" : "Stay & Dine"}</p>
                  <TonePill tone={check.status === "verified" ? "success" : check.status === "blocked" ? "danger" : "neutral"}>
                    {check.status === "verified" ? "Verified" : check.status === "blocked" ? "Blocked" : "Unverified"}
                  </TonePill>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{check.detail}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(check.checkedAt)}</p>
              </div>
              <div className="flex items-center gap-3 text-sm">
                {check.path ? <a href={check.path} target="_blank" rel="noreferrer" className="underline">Open public link</a> : null}
                {check.status !== "verified" && canAccessPath(can, "/admin/public-experience") ? <Link to="/admin/public-experience" className="underline">Review publication</Link> : null}
              </div>
            </li>
          ))}
        </ul>}
    </SectionCard>
  );
}
