import { useEffect, useMemo, useState } from "react";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, LayoutGrid, Save, Search, Lock } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useBranchScope } from "@/lib/branches";
import { logAudit } from "@/lib/audit";
import { cn } from "@/lib/utils";
import { SetupProgressCard } from "@/components/common/SetupProgressCard";
import { NavRail } from "@/components/common/SectionTabs";
import {
  ConfigurationOverview,
  ConfigurationSummaryStrip,
} from "@/components/settings/ConfigurationOverview";
import { EmailReadinessChecklist } from "@/components/settings/EmailReadinessChecklist";
import { EmailVerificationReminder } from "@/components/settings/EmailVerificationReminder";

import {
  entryCapability,
  matchesQuery,
  visibleCategories,
  type SettingsEntry,
} from "@/lib/settings-catalogue";
import { STATUS_LABEL, useSettingsStatuses, type SettingsStatus } from "@/lib/settings-status";
import { EmptyState, NotAuthorisedState } from "@/components/common/StateSystem";
import { auditWindowFrom } from "@/lib/audit-window";

/** Calm for configured surfaces, loud only where an operator must act. */
function StatusBadge({ status }: { status: SettingsStatus }) {
  if (status === "unknown") return null;
  // State is metadata: a dot plus a quiet label, never a bordered chip that
  // could be mistaken for something to press.
  const dot =
    status === "attention"
      ? "bg-destructive"
      : status === "configured"
        ? "bg-success"
        : "bg-warning";
  const text =
    status === "attention"
      ? "text-destructive"
      : status === "configured"
        ? "text-muted-foreground"
        : "text-warning";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-[0.7rem] font-medium uppercase tracking-[0.08em]",
        text,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Scope of a configuration surface — quiet metadata beside the status. */
function ScopeMeta({ scope }: { scope: string }) {
  return (
    <span className="text-[0.7rem] uppercase tracking-[0.08em] text-muted-foreground/80">
      {scope}
    </span>
  );
}

/**
 * Configuration Centre.
 *
 * One enterprise-grade home for every configuration surface: a persistent
 * category rail, a search box across the whole catalogue, and grouped cards
 * that either open a configuration page or edit an organisation-wide rule in
 * place. Visibility is resolved through the same capability registry the route
 * guard uses, so nothing is offered that the guard would refuse.
 */

export const Route = createFileRoute("/_shell/settings")({
  head: () => ({
    meta: [
      { title: "Configuration Centre — NEØ" },
      {
        name: "description",
        content:
          "Every configuration surface for your hospitality group: organisation, access, front office, F&B, finance, procurement, CRM, events, integrations, brand and security.",
      },
      { property: "og:title", content: "Configuration Centre — NEØ" },
      {
        property: "og:description",
        content:
          "Search, discover and edit every operating rule and module setting from one premium configuration hub.",
      },
    ],
  }),
  component: GuardedPage,
});

type Settings = {
  checkInTime: string;
  checkOutTime: string;
  dayEndTime: string;
  fiscalYearStart: string;
  invoicePrefix: string;
  receiptPrefix: string;
  poPrefix: string;
  numberPadding: number;
  voidThreshold: number;
  discountThreshold: number;
  purchaseThreshold: number;
  passwordMinLength: number;
  passwordRequireSymbol: boolean;
  passwordExpiryDays: number;
  sessionTimeoutMinutes: number;
  maxFailedAttempts: number;
  lockoutMinutes: number;
  enforceTwoFactor: boolean;
  singleSessionPerUser: boolean;
  restrictIps: boolean;
  allowedIps: string;
};

const DEFAULTS: Settings = {
  checkInTime: "14:00",
  checkOutTime: "10:00",
  dayEndTime: "23:59",
  fiscalYearStart: "01-01",
  invoicePrefix: "INV",
  receiptPrefix: "RCT",
  poPrefix: "PO",
  numberPadding: 6,
  voidThreshold: 0,
  discountThreshold: 10,
  purchaseThreshold: 50000,
  passwordMinLength: 10,
  passwordRequireSymbol: true,
  passwordExpiryDays: 90,
  sessionTimeoutMinutes: 30,
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
  enforceTwoFactor: false,
  singleSessionPerUser: false,
  restrictIps: false,
  allowedIps: "",
};

/** Landing view key: the whole configuration surface, before drilling in. */
const OVERVIEW_KEY = "__overview";

function SettingsPage() {
  const { applyTo, filterKey } = useActivePropertyFilter();
  const { organizationId, isAdmin, user, profile, can } = useAuth();
  const { activeBranch, orgWide } = useBranchScope();
  const qc = useQueryClient();
  const [form, setForm] = useState<Settings>(DEFAULTS);
  const [saved, setSaved] = useState<Settings>(DEFAULTS);
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState(OVERVIEW_KEY);


  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(saved), [form, saved]);

  // Every badge below is derived from saved state in the database.
  const { data: statuses } = useSettingsStatuses(Boolean(organizationId));

  const categories = useMemo(
    () =>
      visibleCategories((entry) => {
        const cap = entryCapability(entry);
        return cap === null || can(cap.module, cap.feature, cap.action);
      }),
    [can],
  );

  useEffect(() => {
    if (activeKey === OVERVIEW_KEY) return;
    if (categories.length && !categories.some((c) => c.key === activeKey)) {
      setActiveKey(OVERVIEW_KEY);
    }
  }, [categories, activeKey]);


  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const historyQuery = useQuery({
    queryKey: ["system-settings-history", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await applyTo(
        supabase.from("audit_logs").select("id, action, user_name, created_at"),
        "audit_logs",
      )
        .eq("action", "settings.updated")
        .gte("created_at", auditWindowFrom())
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });

  const settingsQuery = useQuery({
    queryKey: ["system-settings", organizationId, filterKey],
    enabled: Boolean(organizationId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("system_settings")
        .select("settings")
        .maybeSingle();
      if (error) throw error;
      return ((data?.settings as Partial<Settings> | undefined) ?? {}) as Partial<Settings>;
    },
  });

  useEffect(() => {
    if (settingsQuery.data) {
      const next = { ...DEFAULTS, ...settingsQuery.data };
      setForm(next);
      setSaved(next);
    }
  }, [settingsQuery.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (!organizationId) return;
      const { error } = await supabase
        .from("system_settings")
        .upsert(
          { organization_id: organizationId, settings: form, updated_at: new Date().toISOString() },
          { onConflict: "organization_id" },
        );
      if (error) throw error;
      await logAudit({
        organizationId,
        userId: user?.id ?? null,
        userName: profile?.full_name ?? "",
        action: "settings.updated",
        module: "administration",
        previousValue: saved,
        newValue: form,
      });
    },
    onSuccess: () => {
      toast.success("Settings saved");
      setSaved(form);
      void qc.invalidateQueries({ queryKey: ["system-settings", filterKey] });
      void qc.invalidateQueries({ queryKey: ["system-settings-history", filterKey] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const num = (key: keyof Settings, label: string) => (
    <div className="space-y-2">
      <Label htmlFor={String(key)}>{label}</Label>
      <Input
        id={String(key)}
        type="number"
        disabled={!isAdmin}
        value={String(form[key])}
        onChange={(e) => set(key, Number(e.target.value) as Settings[typeof key])}
      />
    </div>
  );

  const text = (key: keyof Settings, label: string, type = "text") => (
    <div className="space-y-2">
      <Label htmlFor={String(key)}>{label}</Label>
      <Input
        id={String(key)}
        type={type}
        disabled={!isAdmin}
        value={String(form[key])}
        onChange={(e) => set(key, e.target.value as Settings[typeof key])}
      />
    </div>
  );

  const toggle = (key: keyof Settings, label: string, hint: string) => (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div>
        <Label htmlFor={String(key)}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch
        id={String(key)}
        disabled={!isAdmin}
        checked={Boolean(form[key])}
        onCheckedChange={(v) => set(key, v as Settings[typeof key])}
      />
    </div>
  );

  const panelContent = (panel: NonNullable<SettingsEntry["panel"]>) => {
    if (panel === "operations") {
      return (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {text("checkInTime", "Check-in time", "time")}
          {text("checkOutTime", "Check-out time", "time")}
          {text("dayEndTime", "Day-end cut-off", "time")}
          {text("fiscalYearStart", "Fiscal year start (MM-DD)")}
        </div>
      );
    }
    if (panel === "numbering") {
      return (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {text("invoicePrefix", "Invoice prefix")}
          {text("receiptPrefix", "Receipt prefix")}
          {text("poPrefix", "Purchase order prefix")}
          {num("numberPadding", "Number padding")}
        </div>
      );
    }
    if (panel === "approvals") {
      return (
        <div className="grid gap-4 sm:grid-cols-3">
          {num("voidThreshold", "Void amount threshold")}
          {num("discountThreshold", "Discount % threshold")}
          {num("purchaseThreshold", "Purchase amount threshold")}
        </div>
      );
    }
    if (panel === "security") {
      return (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {num("passwordMinLength", "Minimum password length")}
            {num("passwordExpiryDays", "Password expiry (days)")}
            {num("sessionTimeoutMinutes", "Session timeout (minutes)")}
            {num("maxFailedAttempts", "Maximum failed attempts")}
            {num("lockoutMinutes", "Lockout duration (minutes)")}
            {text("allowedIps", "Allowed IP addresses (comma separated)")}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {toggle(
              "passwordRequireSymbol",
              "Require a symbol",
              "Passwords must contain a non-alphanumeric character.",
            )}
            {toggle(
              "enforceTwoFactor",
              "Enforce two-factor",
              "Every account must complete a second factor at sign-in.",
            )}
            {toggle(
              "singleSessionPerUser",
              "Single active session",
              "Signing in elsewhere ends the previous session.",
            )}
            {toggle(
              "restrictIps",
              "Restrict by IP",
              "Only the allowed addresses above may sign in.",
            )}
          </div>
        </div>
      );
    }
    return historyQuery.data?.length ? (
      <ul className="divide-y divide-border">
        {historyQuery.data.map((row) => (
          <li key={row.id} className="flex items-center gap-3 py-2.5 text-sm">
            <History className="size-4 text-muted-foreground" />
            <span className="font-medium text-foreground">{row.user_name || "Unknown user"}</span>
            <span className="text-muted-foreground">updated system settings</span>
            <span className="ml-auto text-xs text-muted-foreground">
              {new Date(row.created_at as string).toLocaleString()}
            </span>
          </li>
        ))}
      </ul>
    ) : (
      <EmptyState inline title="No settings changes" description="No settings changes have been recorded yet." />
    );
  };

  const searching = query.trim().length > 0;
  const overview = !searching && activeKey === OVERVIEW_KEY;
  const shownCategories = searching
    ? categories
        .map((c) => ({ ...c, entries: c.entries.filter((e) => matchesQuery(e, query)) }))
        .filter((c) => c.entries.length > 0)
    : categories.filter((c) => c.key === activeKey);
  const resultCount = shownCategories.reduce((n, c) => n + c.entries.length, 0);


  return (
    <div>
      <PageHeader
        eyebrow="Administration"
        title="Configuration Centre"
        description="Every operating rule, module setting and integration for your group — grouped, searchable and scope-aware."
        actions={
          isAdmin ? (
            <div className="flex items-center gap-2">
              {dirty ? <Badge variant="outline">Unsaved changes</Badge> : null}
              <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty}>
                <Save className="size-4" /> Save changes
              </Button>
            </div>
          ) : null
        }
      />

      <div className="mb-7 grid gap-3 rounded-xl border border-outline-subtle bg-surface-2/60 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search every setting — tax, logo, password, menu, escalation…"
            className="bg-background pl-9"
            aria-label="Search settings"
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm sm:justify-end">
          <span className="text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Scope
          </span>
          <span className="truncate font-medium text-foreground">
            {orgWide && !activeBranch ? "All properties" : (activeBranch?.name ?? "Not configured")}
          </span>
          {searching ? (
            <span className="text-muted-foreground">
              · {resultCount} match{resultCount === 1 ? "" : "es"}
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-8">
        <div className="lg:sticky lg:top-20 lg:self-start">
          <p className="mb-2 hidden text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground lg:block">
            Categories
          </p>
          <NavRail
            ariaLabel="Settings categories"
            activeKey={searching ? null : activeKey}
            onSelect={(key) => {
              setQuery("");
              setActiveKey(key);
            }}
            items={[
              {
                key: OVERVIEW_KEY,
                label: "All domains",
                icon: LayoutGrid,
                meta: categories.length,
              },
              ...categories.map((category) => ({
                key: category.key,
                label: category.title,
                icon: category.icon,
                meta: category.entries.length,
              })),
            ]}
          />
          {categories.length === 0 ? (
            <NotAuthorisedState
              inline
              subject="any configuration category"
              detail="You have no configuration permissions in this workspace."
            />
          ) : null}
        </div>

        <div className="space-y-6">
          {overview ? (
            <>
              <ConfigurationSummaryStrip categories={categories} statuses={statuses} />
              <SetupProgressCard />
              <SectionCard
                title="Configuration domains"
                description="Every domain your group configures, with readiness derived from saved data. Open a domain to configure it."
              >
                <ConfigurationOverview
                  categories={categories}
                  statuses={statuses}
                  onOpen={(key) => {
                    setQuery("");
                    setActiveKey(key);
                  }}
                />
              </SectionCard>
              <EmailReadinessChecklist />
              <EmailVerificationReminder />
            </>
          ) : null}

          {!overview && !searching ? (
            <Button
              variant="ghost"
              size="sm"
              data-touch-target
              className="-ml-2 w-fit"
              onClick={() => setActiveKey(OVERVIEW_KEY)}
            >
              <LayoutGrid className="size-4" /> All configuration domains
            </Button>
          ) : null}


          {shownCategories.map((category) => (
            <SectionCard
              key={category.key}
              title={category.title}
              description={category.description}
            >
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {category.entries
                    .filter((entry) => entry.to)
                    .map((entry) => {
                      const Icon = entry.icon;
                      const status = statuses?.[entry.to!] ?? "unknown";
                      return (
                        <Link
                          key={entry.to}
                          to={entry.to!}
                          data-touch-target
                          className={cn(
                            "group flex min-h-[6.5rem] flex-col rounded-xl border p-3.5 transition-colors hover:border-primary/50 hover:bg-primary-soft/25",
                            status === "attention"
                              ? "border-destructive/40 bg-destructive/5"
                              : "border-outline-subtle",
                          )}
                        >
                          {/* The whole card is the action, so there is no arrow
                              or filled glyph competing with the title. */}
                          <div className="flex items-start gap-2.5">
                            <Icon
                              aria-hidden
                              className="mt-0.5 size-4 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-primary"
                            />
                            <span className="min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground">
                              {entry.label}
                            </span>
                          </div>
                          <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                            {entry.description}
                          </p>
                          <div className="mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-3">
                            <ScopeMeta scope={entry.scope} />
                            <StatusBadge status={status} />
                          </div>
                        </Link>
                      );
                    })}
                </div>

                {category.entries
                  .filter((entry) => entry.panel)
                  .map((entry) => {
                    const Icon = entry.icon;
                    return (
                      <div key={entry.label} className="surface-inset p-4">
                        <div className="mb-4 flex items-start gap-2.5">
                          <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                              <h3 className="text-sm font-semibold text-foreground">
                                {entry.label}
                              </h3>
                              <ScopeMeta scope={entry.scope} />
                              <StatusBadge
                                status={statuses?.[`panel:${entry.panel}`] ?? "unknown"}
                              />
                              {dirty ? (
                                <span className="text-[0.7rem] font-medium uppercase tracking-[0.08em] text-primary">
                                  Unsaved
                                </span>
                              ) : null}
                            </div>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {entry.description}
                            </p>
                          </div>
                        </div>
                        {panelContent(entry.panel!)}
                      </div>
                    );
                  })}
              </div>
            </SectionCard>
          ))}

          {searching && resultCount === 0 ? (
            <SectionCard
              title="No matches"
              description={`Nothing in the configuration catalogue matches “${query}”.`}
            >
              <Button variant="outline" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </SectionCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/settings">
      <SettingsPage />
    </OpsGuard>
  );
}
