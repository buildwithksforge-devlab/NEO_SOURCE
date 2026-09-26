import { guardedRpc } from "@/lib/rpc-guard";
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Brain, Loader2, ShieldCheck } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { navigation } from "@/lib/navigation";
import { capabilityForPath, capabilityKey } from "@/lib/capabilities";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { ErrorState } from "@/components/common/StateSystem";

export const Route = createFileRoute("/admin/ai-simulator")({
  head: () => ({
    meta: [
      { title: "Intelligence Access Simulator — NEØ Administration" },
      {
        name: "description",
        content:
          "Preview the properties, departments, stations, capabilities and pages NEØ Intelligence may use for any staff member — without exposing their operational data.",
      },
      { property: "og:title", content: "Intelligence Access Simulator — NEØ Administration" },
      {
        property: "og:description",
        content: "Confirm the scope NEØ Intelligence applies for a staff member before they sign in.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: AiSimulatorPage,
});

type SimRole = { id: string; name: string; key: string | null; scope: string | null; is_primary: boolean | null };
type Simulation = {
  user_id: string;
  full_name: string | null;
  account_type: string | null;
  account_status: string | null;
  branch_ids: string[];
  primary_branch_id: string | null;
  department_id: string | null;
  roles: SimRole[];
  capabilities: string[];
};

/** A capability set answers a page the same way the route guard does. */
function grants(set: Set<string>, key: string) {
  const [module, feature, action] = key.split(".");
  return (
    set.has(key) ||
    set.has(`${module}.*.${action}`) ||
    set.has(`${module}.${feature}.manage`) ||
    set.has(`${module}.*.manage`)
  );
}

function AiSimulatorPage() {
  const { organizationId, can } = useAuth();
  const [userId, setUserId] = useState<string>("");
  const [search, setSearch] = useState("");

  const mayPreview = can("administration", "workspace", "edit");

  const staff = useQuery({
    queryKey: ["ai-simulator-staff", organizationId],
    enabled: Boolean(organizationId) && mayPreview,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, account_status")
        .eq("organization_id", organizationId!)
        .order("full_name")
        .limit(500);
      if (error) throw error;
      return (data ?? []) as { id: string; full_name: string | null; account_status: string | null }[];
    },
  });

  const simulation = useQuery({
    queryKey: ["ai-simulation", userId],
    enabled: Boolean(userId) && mayPreview,
    queryFn: async () => {
      const { data, error } = await guardedRpc(supabase, "neo_simulate_access" as never, {
        _user: userId,
      } as never);
      if (error) throw error;
      return data as unknown as Simulation;
    },
  });

  const capabilities = useMemo(
    () => new Set(simulation.data?.capabilities ?? []),
    [simulation.data],
  );

  const pages = useMemo(() => {
    if (!simulation.data) return [];
    return navigation.flatMap((group) =>
      group.items.map((item) => {
        const capability = capabilityForPath(item.to);
        const key = capability ? capabilityKey(capability) : null;
        return {
          group: group.title,
          label: item.label,
          to: item.to,
          capability: key,
          allowed: key === null || grants(capabilities, key),
        };
      }),
    );
  }, [simulation.data, capabilities]);

  const filteredPages = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pages;
    return pages.filter(
      (p) =>
        p.label.toLowerCase().includes(q) ||
        p.group.toLowerCase().includes(q) ||
        (p.capability ?? "").toLowerCase().includes(q),
    );
  }, [pages, search]);

  if (!mayPreview) {
    return (
      <AccessDeniedPanel
        subject="Intelligence Access Simulator"
        detail="Previewing another member's intelligence scope requires workspace administration."
      />
    );
  }

  const allowedPages = pages.filter((p) => p.allowed).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Intelligence Access Simulator"
        description="NEØ Intelligence answers only from the properties, departments, stations and capabilities a person holds. This preview reports that scope for any staff member — the capability contract only, never their operational records."
      />

      <SectionCard
        title="Staff member"
        description="Choose an account to inspect. Nothing is changed and no records are read."
      >
        <div className="flex flex-wrap gap-3">
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder={staff.isLoading ? "Loading staff…" : "Select a staff member"} />
            </SelectTrigger>
            <SelectContent>
              {(staff.data ?? []).map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.full_name || "Unnamed account"}
                  {s.account_status && s.account_status !== "active" ? ` — ${s.account_status}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {simulation.isFetching ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Resolving effective access…
            </span>
          ) : null}
        </div>
        {simulation.isError ? (
          <ErrorState className="mt-3" error={simulation.error} inline />
        ) : null}
      </SectionCard>

      {simulation.data ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Capabilities" value={String(capabilities.size)} icon={ShieldCheck} />
            <StatCard label="Pages reachable" value={`${allowedPages}/${pages.length}`} icon={Brain} />
            <StatCard label="Properties in scope" value={String(simulation.data.branch_ids?.length ?? 0)} />
            <StatCard label="Account status" value={simulation.data.account_status ?? "unknown"} />
          </div>

          <SectionCard
            title="Scope NEØ Intelligence will apply"
            description="Every answer, figure and insight is filtered to exactly this scope."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase text-muted-foreground">Roles</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(simulation.data.roles ?? []).length === 0 ? (
                    <StatusPill tone="warning">No role assigned</StatusPill>
                  ) : (
                    simulation.data.roles.map((r) => (
                      <StatusPill key={r.id} tone={r.is_primary ? "success" : "info"}>
                        {r.name}
                        {r.scope ? ` · ${r.scope}` : ""}
                      </StatusPill>
                    ))
                  )}
                </div>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Account type</p>
                <p className="text-sm">{simulation.data.account_type ?? "staff"}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Property identifiers</p>
                <p className="break-all text-sm text-muted-foreground">
                  {(simulation.data.branch_ids ?? []).join(", ") || "None assigned"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Department identifier</p>
                <p className="break-all text-sm text-muted-foreground">
                  {simulation.data.department_id ?? "None assigned"}
                </p>
              </div>
            </div>
          </SectionCard>

          <SectionCard
            title="Pages and capabilities"
            description="What this member may open, resolved through the same capability registry the route guard uses."
          >
            <Input
              placeholder="Filter by page, group or capability…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="mb-4 max-w-sm"
            />
            <ul className="divide-y divide-border rounded-lg border border-border">
              {filteredPages.map((p) => (
                <li key={p.to} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{p.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.group} · {p.capability ?? "universal page"}
                    </p>
                  </div>
                  <StatusPill tone={p.allowed ? "success" : "default"}>
                    {p.allowed ? "Permitted" : "Not permitted"}
                  </StatusPill>
                </li>
              ))}
            </ul>
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
