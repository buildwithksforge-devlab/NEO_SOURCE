import { useBranchScope } from "@/lib/branches";
import { useState } from "react";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  CircleAlert,
  ExternalLink,
  History,
  Inbox,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import {
  Atomic,
  PageHeader,
  RecordTitle,
  ResponsiveRowActions,
  SectionCard,
  StatCard,
  StatusPill,
  type SecondaryAction,
} from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/common/StateSystem";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useNotificationInbox } from "@/lib/notifications-inbox";
import { CommitmentsInbox } from "@/components/common/CommitmentsInbox";
import { WorkerPushSettings } from "@/components/notifications/WorkerPushSettings";
import {
  ATTENTION_LABEL,
  ATTENTION_TONE,
  attentionState,
  sortByAttention,
} from "@/lib/notification-priority";

export const Route = createFileRoute("/_shell/notifications")({
  head: () => ({
    meta: [
      { title: "Notifications — NEØ" },
      {
        name: "description",
        content: "Action required, approvals, tasks, operational alerts and workflow history.",
      },
      { property: "og:title", content: "Notifications — NEØ" },
      {
        property: "og:description",
        content: "Action required, approvals, tasks, operational alerts and workflow history.",
      },
    ],
  }),
  component: NotificationsPage,
});

type Notification = {
  id: string;
  category: string;
  title: string;
  body: string;
  link: string | null;
  priority: string;
  read_at: string | null;
  created_at: string;
  action_required: boolean | null;
  status: string | null;
  acted_at: string | null;
  source_module: string | null;
  source_record_id: string | null;
  event_type: string | null;
  branch_id?: string | null;
};

type Prefs = {
  in_app: boolean;
  email: boolean;
  whatsapp: boolean;
  sms: boolean;
  push: boolean;
};

const CHANNELS: { key: keyof Prefs; label: string }[] = [
  { key: "in_app", label: "In-app" },
  { key: "email", label: "Email" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "sms", label: "SMS" },
  { key: "push", label: "Push" },
];

/**
 * End-to-end notification categories. Every notice is produced by a real
 * operational event in the database (approval raised or decided, task
 * assigned or completed, departure clean raised, inspection required or
 * failed) and carries a deep link to the secured record it came from.
 */
const VIEWS: { key: string; label: string; match: (n: Notification) => boolean }[] = [
  {
    key: "action-required",
    label: "Action required",
    match: (n) => Boolean(n.action_required) && (n.status ?? "open") === "open",
  },
  { key: "approvals", label: "Approvals", match: (n) => n.category === "approvals" },
  {
    key: "tasks",
    label: "Tasks",
    match: (n) => n.category === "tasks" || n.category === "task-assignment",
  },
  {
    key: "operational",
    label: "Operational alerts",
    match: (n) => n.category === "operational-alert" || n.category === "system-alert",
  },
  {
    key: "priority",
    label: "Priority",
    match: (n) => n.priority === "high" || n.priority === "urgent",
  },
  {
    key: "rooms",
    label: "Rooms & readiness",
    match: (n) =>
      (n.source_module ?? "") === "housekeeping" ||
      (n.source_module ?? "") === "pms" ||
      (n.event_type ?? "").startsWith("housekeeping.") ||
      (n.event_type ?? "").startsWith("reservation."),
  },
  {
    key: "workflow",
    label: "Workflow history",
    match: (n) => n.category === "workflow" || (n.status ?? "open") !== "open",
  },
];


/**
 * Housekeeping and Front Office notices name the room in their subject line —
 * the notification record itself holds no room column, so the reference is
 * read from the notice text and labelled as such rather than implied to be a
 * database relation.
 */
function roomReference(n: Notification): string | null {
  const match = `${n.title ?? ""} ${n.body ?? ""}`.match(/\bRoom\s+([A-Za-z0-9-]{1,12})\b/);
  return match ? (match[1] ?? null) : null;
}

/** Outcomes a reader may record against an actionable notice. */
type Outcome = "acknowledged" | "resolved" | "retried" | "escalated";

const OUTCOME_LABEL: Record<Outcome, string> = {
  acknowledged: "Acknowledged",
  resolved: "Marked resolved",
  retried: "Reopened for another attempt",
  escalated: "Escalated to your supervisor",
};

type HistoryEntry = { id: string; action: string; created_at: string; note: string | null };

/** The recorded outcome trail for one notice — evidence, not client state. */
function OutcomeHistory({ notificationId }: { notificationId: string }) {
  const history = useQuery({
    queryKey: ["notification-history", notificationId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notification_history" as never)
        .select("id, action, created_at, note")
        .eq("notification_id", notificationId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as HistoryEntry[];
    },
  });

  if (history.isLoading)
    return <p className="mt-2 text-xs text-muted-foreground">Loading history…</p>;
  const rows = history.data ?? [];
  if (rows.length === 0)
    return <p className="mt-2 text-xs text-muted-foreground">No outcome recorded yet.</p>;

  return (
    <ul className="mt-2 space-y-1 border-l border-border pl-3">
      {rows.map((h) => (
        <li key={h.id} className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{h.action}</span> ·{" "}
          {new Date(h.created_at).toLocaleString()}
          {h.note ? ` · ${h.note}` : ""}
        </li>
      ))}
    </ul>
  );
}

function NotificationsPage() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId, user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  // Housekeeping and Front Office share one inbox; these narrow it without
  // ever widening what the visibility contract already allowed.
  const [roomFilter, setRoomFilter] = useState("all");
  const [propertyFilter, setPropertyFilter] = useState("all");
  const [transitionFilter, setTransitionFilter] = useState("all");
  const { branches } = useBranchScope();

  // Shared inbox: the same scoped rows and the same visibility rules the
  // header badge counts, so the list and the count always reconcile.
  const inbox = useNotificationInbox();
  const notifications = inbox.query;


  const prefs = useQuery({
    queryKey: ["notification-preferences", user?.id, filterKey],
    enabled: Boolean(user?.id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notification_preferences")
        .select("in_app, email, whatsapp, sms, push")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return (
        (data as Prefs | null) ?? {
          in_app: true,
          email: true,
          whatsapp: false,
          sms: false,
          push: false,
        }
      );
    },
  });

  const savePrefs = useMutation({
    mutationFn: async (patch: Partial<Prefs>) => {
      if (!organizationId || !user) return;
      const { error } = await supabase
        .from("notification_preferences")
        .upsert(
          { organization_id: organizationId, user_id: user.id, ...prefs.data, ...patch },
          { onConflict: "user_id" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Preferences saved");
      void qc.invalidateQueries({ queryKey: ["notification-preferences", filterKey] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const markRead = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications-unread"] }),
    onError: (e: Error) => toast.error(e.message),
  });

  /**
   * Every outcome is recorded permanently, so who acted on what — and what the
   * outcome was — stays auditable. Acknowledging admits the notice; resolving
   * closes it; retry reopens it for another attempt; escalation hands it up.
   */
  const act = useMutation({
    mutationFn: async ({ n, action }: { n: Notification; action: Outcome }) => {
      if (!organizationId || !user) return;
      const { error } = await supabase.from("notification_history" as never).insert({
        organization_id: organizationId,
        notification_id: n.id,
        actor_id: user.id,
        action,
      } as never);
      if (error) throw error;
      const now = new Date().toISOString();
      const patch =
        action === "resolved" || action === "escalated"
          ? {
              read_at: now,
              status: action === "resolved" ? "resolved" : "escalated",
              acted_at: now,
              acted_by: user.id,
            }
          : action === "retried"
            ? { read_at: now, status: "open", acted_at: null }
            : { read_at: now };
      const { error: upErr } = await supabase.from("notifications").update(patch).eq("id", n.id);
      if (upErr) throw upErr;
    },
    onSuccess: (_d, vars) => {
      toast.success(OUTCOME_LABEL[vars.action]);
      void qc.invalidateQueries({ queryKey: ["notifications-unread"] });
      void qc.invalidateQueries({ queryKey: ["notification-history", filterKey] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const all: Notification[] = inbox.items;
  const unread: Notification[] = inbox.unread;

  const activeApprovals = useQuery({
    queryKey: ["active-approval-ids", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase.from("approval_requests").select("id"),
        "approval_requests",
      ).eq("status", "pending_approval");
      if (error) throw error;
      return (data ?? []).map((r) => r.id as string);
    },
  });
  const activeApprovalIds = new Set(activeApprovals.data ?? []);

  /**
   * An approvals notice only counts as action-required while its request still
   * has an active approval step. Resolved, superseded or finalised chains drop
   * out of the queue automatically.
   */
  const matchFor = (v: (typeof VIEWS)[number]) =>
    v.key === "action-required"
      ? (n: Notification) =>
          v.match(n) &&
          (n.source_module !== "approvals" ||
            !n.source_record_id ||
            activeApprovalIds.has(n.source_record_id))
      : v.match;

  const counts = Object.fromEntries(VIEWS.map((v) => [v.key, all.filter(matchFor(v)).length]));
  const view = VIEWS.find((v) => v.key === filter);
  /**
   * Attention order, not arrival order: failed and blocked work sits at the
   * top, informational history at the bottom, newest first inside each band.
   */
  const base =
    filter === "all" ? all : filter === "unread" ? unread : view ? all.filter(matchFor(view)) : all;
  const roomOptions = Array.from(
    new Set(all.map(roomReference).filter((r): r is string => Boolean(r))),
  ).sort();
  const transitionOptions = Array.from(
    new Set(all.map((n) => n.event_type ?? "").filter(Boolean)),
  ).sort();
  const visible = sortByAttention(
    base.filter(
      (n) =>
        (roomFilter === "all" || roomReference(n) === roomFilter) &&
        (propertyFilter === "all" || n.branch_id === propertyFilter) &&
        (transitionFilter === "all" || n.event_type === transitionFilter),
    ),
  );

  const openRecord = (link: string | null) => {
    if (!link) return;
    void navigate({ to: link });
  };

  const actionRequired = counts["action-required"] ?? 0;
  const priority = counts["priority"] ?? 0;

  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="Notification centre"
        icon={Bell}
        description="Approvals, task assignments, operational alerts and workflow history, raised by real operational events and linked to the record they came from."
        meta={
          <>
            <StatusPill tone={actionRequired > 0 ? "warning" : "success"}>
              {actionRequired > 0 ? `${actionRequired} need action` : "Nothing needs action"}
            </StatusPill>
            <StatusPill tone={unread.length > 0 ? "info" : "default"}>
              {`${unread.length} unread`}
            </StatusPill>
            <StatusPill tone={priority > 0 ? "destructive" : "default"}>
              {`${priority} high priority`}
            </StatusPill>
          </>
        }
        actions={
          unread.length > 0 ? (
            <Button variant="outline" onClick={() => markRead.mutate(unread.map((n) => n.id))}>
              <CheckCheck className="size-4" /> Mark all read
            </Button>
          ) : null
        }
      />

      {/* Weighted summary: what needs a decision leads, history recedes. */}
      <div className="neo-kpi-grid mb-6">
        <StatCard
          lead
          label="Action required"
          value={String(actionRequired)}
          hint="Open notices waiting on a decision from you"
          icon={CircleAlert}
        />
        <StatCard
          label="Unread"
          value={String(unread.length)}
          hint={`of ${all.length} in your scope`}
          icon={Bell}
          tone={unread.length > 0 ? "info" : "default"}
        />
        <StatCard
          label="Approvals"
          value={String(counts["approvals"] ?? 0)}
          hint="Raised through the authority matrix"
          icon={ShieldCheck}
        />
        <StatCard
          label="High priority"
          value={String(priority)}
          hint="Urgent and high-severity notices"
          icon={AlertTriangle}
          tone={priority > 0 ? "warning" : "default"}
        />
      </div>

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <SectionCard
          accent
          icon={Inbox}
          title="Inbox"
          description={`${unread.length} unread of ${all.length}`}
        >
          <Tabs value={filter} onValueChange={setFilter}>
            <TabsList variant="pill" className="w-full">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="unread">Unread ({unread.length})</TabsTrigger>
              {VIEWS.map((v) => (
                <TabsTrigger key={v.key} value={v.key}>
                  {v.label} ({counts[v.key] ?? 0})
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="flex flex-wrap gap-2 pt-4">
              <Select value={propertyFilter} onValueChange={setPropertyFilter}>
                <SelectTrigger className="h-9 w-full sm:w-52" aria-label="Filter by property">
                  <SelectValue placeholder="All properties" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All properties</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={roomFilter} onValueChange={setRoomFilter}>
                <SelectTrigger className="h-9 w-full sm:w-44" aria-label="Filter by room">
                  <SelectValue placeholder="All rooms" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All rooms</SelectItem>
                  {roomOptions.map((r) => (
                    <SelectItem key={r} value={r}>
                      Room {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={transitionFilter} onValueChange={setTransitionFilter}>
                <SelectTrigger className="h-9 w-full sm:w-60" aria-label="Filter by status transition">
                  <SelectValue placeholder="All status transitions" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All status transitions</SelectItem>
                  {transitionOptions.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <TabsContent value={filter} className="pt-4">

              <QueryState
                isLoading={notifications.isLoading}
                error={notifications.error}
                isEmpty={visible.length === 0}
                onRetry={() => void notifications.refetch()}
                skeleton="rows"
                empty={
                  <EmptyState
                    title="Nothing here yet"
                    description="Approvals, task assignments and operational alerts appear here as they are raised."
                    icon={Bell}
                    inline
                  />
                }
              >
                <ul className="space-y-2">
                  {visible.map((n) => {
                    const state = attentionState(n);
                    const tone = ATTENTION_TONE[state];
                    const secondary: SecondaryAction[] = [
                      ...(n.action_required && (n.status ?? "open") === "open"
                        ? ([
                            {
                              label: "Acknowledge",
                              onSelect: () => act.mutate({ n, action: "acknowledged" }),
                            },
                            {
                              label: "Resolve",
                              onSelect: () => act.mutate({ n, action: "resolved" }),
                            },
                            {
                              label: "Escalate",
                              onSelect: () => act.mutate({ n, action: "escalated" }),
                            },
                          ] as SecondaryAction[])
                        : []),
                      ...((n.status ?? "open") !== "open"
                        ? ([
                            {
                              label: "Retry",
                              onSelect: () => act.mutate({ n, action: "retried" }),
                            },
                          ] as SecondaryAction[])
                        : []),
                      ...(!n.read_at
                        ? ([
                            { label: "Mark read", onSelect: () => markRead.mutate([n.id]) },
                          ] as SecondaryAction[])
                        : []),
                      {
                        label: expanded === n.id ? "Hide history" : "History",
                        onSelect: () => setExpanded((prev) => (prev === n.id ? null : n.id)),
                      },
                    ];

                    return (
                      /* One contained record card per notice. The unread state
                         is carried by a brand rail and an icon well rather than
                         a full wash, so the title is the loudest line; on a
                         phone the actions drop below the text instead of
                         colliding with the badge. */
                      <li
                        key={n.id}
                        data-notification-row
                        className={cn(
                          "relative grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-3 overflow-hidden rounded-xl border p-3 pl-4",
                          n.read_at
                            ? "surface-quiet border-outline-subtle"
                            : "neo-section-rail border-primary/25 bg-primary/[0.04]",
                        )}
                      >
                        <span className="neo-icon-well size-9 shrink-0">
                          <Bell className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
                            <RecordTitle
                              as="p"
                              className="text-[0.95rem] font-semibold leading-snug text-foreground"
                            >
                              {n.title}
                            </RecordTitle>
                            <StatusPill tone={tone}>{ATTENTION_LABEL[state]}</StatusPill>
                          </div>
                          <p className="neo-line-2 neo-contain mt-1 text-sm text-muted-foreground">
                            {n.body}
                          </p>
                          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <Atomic className="capitalize">{n.category.replace(/-/g, " ")}</Atomic>
                            <Atomic>{new Date(n.created_at).toLocaleString()}</Atomic>
                            {n.event_type ? (
                              <span className="inline-flex min-w-0 items-center gap-1">
                                <History className="size-3 shrink-0" />
                                <span className="neo-line-1">{n.event_type}</span>
                              </span>
                            ) : null}
                            {n.acted_at ? (
                              <Atomic>Resolved {new Date(n.acted_at).toLocaleString()}</Atomic>
                            ) : null}
                          </div>
                          <ResponsiveRowActions
                            className="mt-2 justify-end"
                            primary={
                              n.link ? (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => openRecord(n.link)}
                                >
                                  <ExternalLink className="size-4" /> Open
                                </Button>
                              ) : null
                            }
                            secondary={secondary}
                          />
                          {expanded === n.id ? <OutcomeHistory notificationId={n.id} /> : null}
                        </div>
                      </li>
                    );

                  })}
                </ul>
              </QueryState>
            </TabsContent>
          </Tabs>
        </SectionCard>

        <SectionCard title="Delivery preferences" description="Choose available channels and register each phone separately for personal alerts.">
          <div className="space-y-4">
            {CHANNELS.map((c) => (
              <div key={c.key} className="flex items-center justify-between">
                <Label htmlFor={`ch-${c.key}`}>{c.label}{c.key === "push" ? " — not available yet" : ""}</Label>
                <Switch
                  id={`ch-${c.key}`}
                  checked={c.key === "push" ? false : Boolean(prefs.data?.[c.key])}
                  disabled={c.key === "push"}
                  onCheckedChange={(v) => savePrefs.mutate({ [c.key]: v } as Partial<Prefs>)}
                />
              </div>
            ))}
            {prefs.data?.push ? (
              <p className="rounded-lg border border-border bg-muted p-3 text-xs leading-relaxed text-foreground" role="status">
                A saved push preference alone does not confirm this device receives alerts. Register this device and verify an actual phone notification.
              </p>
            ) : null}
            {user?.id && organizationId ? <WorkerPushSettings userId={user.id} organizationId={organizationId} /> : null}
          </div>
        </SectionCard>
      </div>

      {/* Commitments sit BELOW the inbox: notifications lead the page. */}
      <div className="mt-6">
        <CommitmentsInbox />
      </div>
    </div>
  );
}
