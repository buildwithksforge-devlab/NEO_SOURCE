import { createFileRoute } from "@tanstack/react-router";
import { Server } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import {
  AccessDenied,
  EmptyState,
  TonePill,
  TruthNotice,
  humanise,
} from "@/components/platform/PlatformShared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { useEnvironments, useFeatureFlagOverrides, useFeatureFlags } from "@/lib/platform-data";

export const Route = createFileRoute("/_shell/platform/environments")({
  component: EnvironmentsScreen,
});

function EnvironmentsScreen() {
  const { can, isAdmin } = useAuth();
  const environments = useEnvironments();
  const flags = useFeatureFlags();
  const overrides = useFeatureFlagOverrides();

  if (!isAdmin && !can("platform", "view")) {
    return (
      <AccessDenied
        title="Environment configuration is restricted"
        body="Environment separation and feature flags are platform-level controls. Ask an administrator to grant the platform module to your role."
      />
    );
  }

  const overrideCount = (flagId: string) =>
    (overrides.data ?? []).filter((o) => o["flag_id"] === flagId).length;

  return (
    <div className="space-y-6">
      <TruthNotice>
        Development, testing, staging and production are kept separate. Non-production environments
        display a permanent banner, use sandbox provider credentials and never receive live payment
        callbacks.
      </TruthNotice>

      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {(environments.data ?? []).map((e) => (
          <Card key={String(e["id"])} className="surface-panel">
            <CardContent className="space-y-3 py-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 font-semibold text-foreground">
                    <Server className="size-4 text-muted-foreground" />
                    {String(e["name"])}
                  </p>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {humanise(String(e["kind"]))}
                  </p>
                </div>
                <TonePill tone={e["is_production"] ? "success" : "info"}>
                  {e["is_production"] ? "Live" : "Non-production"}
                </TonePill>
              </div>
              {e["banner_label"] ? (
                <p className="rounded-lg bg-warning/20 px-3 py-2 text-xs font-medium text-on-tint-warning">
                  {String(e["banner_label"])}
                </p>
              ) : null}
              <ul className="space-y-1 text-sm text-muted-foreground">
                {(Array.isArray(e["checklist"]) ? (e["checklist"] as string[]) : []).map((c) => (
                  <li key={c}>• {c}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>

      <SectionCard
        title="Feature flags"
        description="Beta capabilities are released deliberately. Flags can be enabled per plan, organisation or branch without a code change."
      >
        {(flags.data ?? []).length === 0 ? (
          <EmptyState
            title="No feature flags defined"
            body="Flags will appear here as capabilities are staged for release."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Flag</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Default</TableHead>
                  <TableHead>Overrides</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(flags.data ?? []).map((f) => (
                  <TableRow key={String(f["id"])}>
                    <TableCell>
                      <p className="font-medium text-foreground">
                        {String(f["name"])}{" "}
                        {f["beta"] ? (
                          <Badge variant="outline" className="ml-2">
                            Beta
                          </Badge>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {String(f["description"] ?? "")}
                      </p>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {humanise(String(f["scope"]))}
                    </TableCell>
                    <TableCell>
                      <TonePill tone={f["default_enabled"] ? "success" : "neutral"}>
                        {f["default_enabled"] ? "On" : "Off"}
                      </TonePill>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {overrideCount(String(f["id"]))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
