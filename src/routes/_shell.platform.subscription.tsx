import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";
import {
  AccessDenied,
  EmptyState,
  TonePill,
  TruthNotice,
  formatDate,
  humanise,
  statusTone,
} from "@/components/platform/PlatformShared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import {
  useEntitlements,
  useOrganizationSubscription,
  useSubscriptionEvents,
  useSubscriptionPlans,
  useUpsertSubscription,
} from "@/lib/platform-data";
import { SUBSCRIPTION_STATUS_LABELS, subscriptionAlert } from "@/lib/platform";

export const Route = createFileRoute("/_shell/platform/subscription")({
  component: SubscriptionScreen,
});

const STATUSES = Object.keys(SUBSCRIPTION_STATUS_LABELS);

function SubscriptionScreen() {
  const { can, isAdmin } = useAuth();
  const plans = useSubscriptionPlans();
  const subscription = useOrganizationSubscription();
  const events = useSubscriptionEvents();
  const entitlements = useEntitlements();
  const save = useUpsertSubscription();

  const current = subscription.data;
  const [planId, setPlanId] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [renewal, setRenewal] = useState<string>("");
  const [initialised, setInitialised] = useState(false);

  if (current && !initialised) {
    setInitialised(true);
    setPlanId(String(current["plan_id"] ?? ""));
    setStatus(String(current["status"] ?? "trial"));
    setRenewal(String(current["renewal_date"] ?? ""));
  }

  if (!isAdmin && !can("platform", "view")) {
    return (
      <AccessDenied
        title="Subscription details are restricted"
        body="Commercial terms are visible only to owners and staff granted the platform module."
      />
    );
  }

  const canEdit = can("platform", "edit");
  const alert = subscriptionAlert(current ?? null);
  const plan = (plans.data ?? []).find((p) => p["id"] === current?.["plan_id"]);
  const planEntitlements = (plan?.["entitlements"] as string[] | undefined) ?? [];

  return (
    <div className="space-y-6">
      <TruthNotice>
        Subscription state controls access, not billing. No payment is taken from this screen and no
        invoice is generated automatically — the record reflects the signed commercial agreement.
      </TruthNotice>

      {alert ? (
        <Card className="border-border">
          <CardContent className="flex items-center gap-3 py-4">
            <TonePill tone={alert.tone}>
              {humanise(String(current?.["status"] ?? "trial"))}
            </TonePill>
            <p className="text-sm text-muted-foreground">{alert.message}</p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Current plan" value={plan ? String(plan["name"]) : "Not assigned"} />
        <StatCard label="Status" value={humanise(String(current?.["status"] ?? "trial"))} />
        <StatCard label="Renewal date" value={formatDate(current?.["renewal_date"] as string)} />
        <StatCard
          label="Entitlements"
          value={String(planEntitlements.length + (entitlements.data ?? []).length)}
        />
      </div>

      <SectionCard
        title="Subscription record"
        description="Plan, contract dates and access status for this organisation."
      >
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label>Plan</Label>
            <Select value={planId} onValueChange={setPlanId} disabled={!canEdit}>
              <SelectTrigger>
                <SelectValue placeholder="Select a plan" />
              </SelectTrigger>
              <SelectContent>
                {(plans.data ?? []).map((p) => (
                  <SelectItem key={String(p["id"])} value={String(p["id"])}>
                    {String(p["name"])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus} disabled={!canEdit}>
              <SelectTrigger>
                <SelectValue placeholder="Select status" />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {humanise(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="renewal">Renewal date</Label>
            <NeoDatePicker
              id="renewal"
              value={renewal}
              disabled={!canEdit}
              onChange={setRenewal}
            />
          </div>
        </div>
        {canEdit ? (
          <div className="mt-4 flex justify-end">
            <Button
              onClick={() =>
                save.mutate({
                  id: current?.["id"],
                  plan_id: planId || null,
                  status: status || "trial",
                  renewal_date: renewal || null,
                })
              }
              disabled={save.isPending}
            >
              Save subscription
            </Button>
          </div>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Plan catalogue"
        description="Commercial packages available to hospitality customers."
      >
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {(plans.data ?? []).map((p) => (
            <Card key={String(p["id"])} className="surface-panel">
              <CardContent className="space-y-2 py-5">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-semibold text-foreground">{String(p["name"])}</p>
                  {p["is_custom"] ? <Badge variant="outline">Custom</Badge> : null}
                </div>
                <p className="text-sm text-muted-foreground">{String(p["description"] ?? "")}</p>
                <p className="text-xs text-muted-foreground">
                  Support level: {humanise(String(p["support_plan_code"] ?? "standard"))}
                </p>
                <div className="flex flex-wrap gap-1 pt-1">
                  {((p["entitlements"] as string[] | undefined) ?? []).slice(0, 8).map((e) => (
                    <Badge key={e} variant="secondary" className="text-[10px]">
                      {humanise(e)}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Subscription history"
        description="Every plan change, renewal, suspension and reactivation is recorded."
      >
        {(events.data ?? []).length === 0 ? (
          <EmptyState
            title="No subscription changes recorded"
            body="Changes to the plan or status will be listed here."
          />
        ) : (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Event</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Effective</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(events.data ?? []).map((e) => (
                  <TableRow key={String(e["id"])}>
                    <TableCell>{humanise(String(e["event_type"]))}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {humanise(String(e["from_status"] ?? ""))}
                    </TableCell>
                    <TableCell>
                      <TonePill tone={statusTone(String(e["to_status"] ?? ""))}>
                        {humanise(String(e["to_status"] ?? ""))}
                      </TonePill>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(e["effective_date"] as string)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        )}
      </SectionCard>
    </div>
  );
}
