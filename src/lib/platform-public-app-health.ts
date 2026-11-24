import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { buildInfo } from "@/lib/build-info";
import { guardedRpc } from "@/lib/rpc-guard";

type Target = { app: "guest" | "delivery"; slug: string | null; state: "published" | "unpublished" | "ambiguous" };
export type PublicAppCheck = Target & {
  path: string | null;
  status: "verified" | "blocked" | "unverified";
  detail: string;
  checkedAt: string;
};

export async function checkPublicApp(target: Target, property: string, expectedBuild: string): Promise<PublicAppCheck> {
  const slug = target.slug;
  const path = slug && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(slug) ? `/${target.app}/${encodeURIComponent(slug)}` : null;
  const checkedAt = new Date().toISOString();
  const verdict = (status: PublicAppCheck["status"], detail: string): PublicAppCheck => ({ ...target, path, status, detail, checkedAt });
  if (target.state === "ambiguous") return verdict("blocked", "More than one Delivery link is published for this property. Review App Branding.");
  if (!path) return verdict(target.state === "published" ? "blocked" : "unverified", "No valid public link is configured for this property.");

  try {
    const response = await fetch(path, {
      credentials: "omit", cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 && target.state === "unpublished") return verdict("unverified", "The property has no published app at this address.");
      return verdict("blocked", response.status === 0 ? "The public link redirected." : `The public link returned HTTP ${response.status}.`);
    }

    const html = await response.text();
    const pageHead = document.createElement("template");
    pageHead.innerHTML = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1] ?? "";
    const identity = pageHead.content.querySelector('meta[name="neo-public-property"]')?.getAttribute("content");
    const build = pageHead.content.querySelector('meta[name="neo-build-id"]')?.getAttribute("content");
    if (target.state !== "published") return identity
      ? verdict("blocked", "The public page is live but its publication record is disabled.")
      : verdict("unverified", "This property has no published app at this address.");
    if (identity !== `${target.app}:${property}`) return verdict("blocked", "The response did not identify the selected property's published app.");
    if (build !== expectedBuild) return verdict("unverified", "The public page is serving a different build. Reload Platform & Readiness and check again.");
    return verdict("verified", "The public page responded for this property and build.");
  } catch {
    return verdict("blocked", "The public page could not be reached within the check window.");
  }
}

function readTargets(value: unknown): Target[] {
  if (!Array.isArray(value) || value.length !== 2 || new Set(value.map((row) => row?.app)).size !== 2 || value.some((row) =>
    !row || !["delivery", "guest"].includes(row.app) || !["published", "unpublished", "ambiguous"].includes(row.state) ||
    (row.slug !== null && typeof row.slug !== "string"))) throw new Error("Public app publication could not be verified.");
  return value as Target[];
}

export function usePublicAppHealth() {
  const { organizationId, user, permissionsLoaded, phase, can, isAdmin } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const allowed = permissionsLoaded && (isAdmin || can("platform", "readiness.view") || can("platform", "quality.view"));
  const query = useQuery({
    queryKey: ["platform", "public-app-health", organizationId, user?.id, branchId, buildInfo.sourceId, allowed],
    enabled: phase === "ready" && Boolean(organizationId && user?.id && branchId) && allowed,
    retry: false,
    staleTime: 2 * 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchIntervalInBackground: false,
    queryFn: async () => {
      if (!branchId) throw new Error("Select a property to check its public links.");
      const { data, error } = await guardedRpc(supabase as never, "neo_platform_public_app_targets", { _branch: branchId });
      if (error) throw new Error("Could not read published links for the selected property.");
      return Promise.all(readTargets(data).map((target) => checkPublicApp(target, branchId, buildInfo.sourceId)));
    },
  });
  return { ...query, allowed, branchId };
}
