import { Bell, CheckCheck, ExternalLink } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  KITCHEN_ALERT_LABELS,
  useKitchenAlertMarkRead,
  useKitchenAlerts,
  useKitchenRaiseAlerts,
} from "@/lib/kitchen-alerts";

/**
 * Realtime kitchen alert feed. Alerts are raised by the server
 * (`neo_kitchen_raise_alerts`, bulk-action rejections) and deduplicated there,
 * so this list never invents or repeats a notice.
 */
export function KitchenAlertsFeed({ limit = 12 }: { limit?: number }) {
  const alerts = useKitchenAlerts(limit);
  const markRead = useKitchenAlertMarkRead();
  const raise = useKitchenRaiseAlerts();
  const navigate = useNavigate();

  const rows = alerts.data ?? [];
  const unread = rows.filter((a) => !a.read_at);

  return (
    <SectionCard
      title="Kitchen alerts"
      description="Assigned station workload, routing regressions and rejected bulk actions, updating live."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={raise.isPending} onClick={() => raise.mutate()}>
            {raise.isPending ? "Checking…" : "Check now"}
          </Button>
          {unread.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => markRead.mutate(unread.map((a) => a.id))}>
              <CheckCheck className="size-4" /> Mark read
            </Button>
          ) : null}
        </div>
      }
    >
      {alerts.isLoading ? (
        <p className="py-6 text-sm text-muted-foreground">Loading alerts…</p>
      ) : alerts.error ? (
        <p className="py-6 text-sm text-destructive">{(alerts.error as Error).message}</p>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
          <Bell className="size-5" /> No kitchen alerts raised.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li
              key={a.id}
              className={`rounded-lg border border-border p-3 ${a.read_at ? "" : "bg-primary-soft/40"}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{a.title}</p>
                    <StatusPill tone={a.priority === "high" ? "destructive" : "info"}>
                      {KITCHEN_ALERT_LABELS[a.event_type ?? ""] ?? a.event_type ?? "Kitchen"}
                    </StatusPill>
                  </div>
                  <p className="text-sm text-muted-foreground">{a.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(a.created_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {a.link ? (
                    <Button size="sm" variant="outline" onClick={() => void navigate({ to: a.link! })}>
                      <ExternalLink className="size-4" /> Open
                    </Button>
                  ) : null}
                  {!a.read_at ? (
                    <Button size="sm" variant="ghost" onClick={() => markRead.mutate([a.id])}>
                      Mark read
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
