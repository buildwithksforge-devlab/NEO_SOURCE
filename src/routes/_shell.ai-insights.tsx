import { useMemo, useState } from "react";
import { OpsGuard } from "@/components/operations/OpsShared";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AlertTriangle, Gauge, Info, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  InsetPanel,
  MetricGrid,
  MetricTile,
  PageHeader,
  SectionCard,
  StatusPill,
  SubsectionHeading,
  TableScroll,
} from "@/components/common/DataDisplay";
import { AccessDeniedPanel } from "@/components/common/AccessState";
import { ScopeBar, useAnalyticsScope } from "@/components/analytics/ScopeBar";
import { useBranchScope } from "@/lib/branches";
import { useMyWork } from "@/lib/my-work";
import { MyWorkBoard } from "@/components/intelligence/MyWork";

import { count, money, percent, useIntelligence, type Anomaly } from "@/lib/intelligence-data";
import { generateBriefingNarrative } from "@/lib/intelligence.functions";
import { AiUnavailableBanner } from "@/components/common/AiUnavailableBanner";
import { ErrorState, LoadingState } from "@/components/common/StateSystem";
import {
  AwaitingData,
  IntelligenceHero,
  IntelligenceRail,
  IntelligenceSection,
  useIntelligenceScrollSpy,
} from "@/components/intelligence/IntelligenceShell";
import {
  AXIS_PROPS,
  ChartCard,
  GRID_PROPS,
  TOOLTIP_PROPS,
  chartSeriesColor,
  ChartGradients,
  chartFill,
  LINE_PROPS,
} from "@/components/charts/ChartKit";
import {
  CommandOverlay,
  ModeNav,
  MorningBrief,
  WhatChanged,
  useCommandShortcut,
  type IntelligenceMode,
} from "@/components/intelligence/CommandCentre";
import { AnswerCard, AskComposer, SuggestedQuestions } from "@/components/intelligence/AskNeo";
import { AbsenceState } from "@/components/intelligence/AbsenceState";
import { VizRenderer } from "@/components/intelligence/VizRenderer";
import { ScenarioSimulator } from "@/components/intelligence/ScenarioSimulator";
import {
  GraphFullscreen,
  RecommendedAction,
  SwipeableBrief,
  VoiceAskButton,
} from "@/components/intelligence/MobileIntelligence";
import { useIsMobile } from "@/hooks/use-mobile";
import { useVisibility } from "@/lib/visibility";
import { lensFor, scopeChanges, scopeDecisions, scopeDiscoveries } from "@/lib/intelligence-role";
import {
  EditorialOpening,
  LeadStory,
  RoutineDisclosure,
  SupportingFindings,
} from "@/components/intelligence/TodayEditorial";
import { DecisionCard, DiscoveryCard } from "@/components/intelligence/DiscoveryCard";
import { InvestigationPane } from "@/components/intelligence/InvestigationPane";
import { NeoBrain } from "@/components/intelligence/NeoBrain";
import { WhatsGoingWell } from "@/components/intelligence/WhatsGoingWell";
import {
  buildBrief,
  buildChanges,
  buildPositives,
  buildDecisions,
  buildDiscoveries,
  buildInvestigation,
  priorPeriod,
  scopeOf,
} from "@/lib/intelligence-engine";
import { askNeo } from "@/lib/intelligence-ask.functions";
import type { ConversationTurn, NeoModule } from "@/lib/intelligence-types";

export const Route = createFileRoute("/_shell/ai-insights")({
  head: () => ({
    meta: [
      { title: "NEØ Intelligence — Executive Pulse & Advisories" },
      {
        name: "description",
        content:
          "Seven-section operational intelligence: executive pulse, revenue and demand, guest experience, operational risk, cost and inventory, workforce and recommendations.",
      },
      { property: "og:title", content: "NEØ Intelligence — Executive Pulse & Advisories" },
      {
        property: "og:description",
        content:
          "Truthful, permission-scoped hospitality intelligence derived from operational records — never fabricated.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

type NarrativeTrace = {
  provider: string;
  model: string | null;
  generated_at: string;
  duration_ms: number;
  source: string;
  period: { from: string; to: string };
  currency: string;
  input_count: number;
  inputs: { label: string; value: string }[];
};

type Narrative = {
  status: string;
  text: string | null;
  model: string | null;
  detail: string | null;
  trace?: NarrativeTrace;
};

/**
 * Provenance for whatever narrative is shown: which provider answered, how long
 * it took, and the deterministic values it was allowed to use.
 */
function IntelligenceTrace({ narrative }: { narrative: Narrative | null }) {
  const trace = narrative?.trace;
  const configured = narrative?.status === "ok";
  return (
    <SectionCard
      tone="quiet"
      title="Intelligence trace"
      description="What produced the text above, and the data it was allowed to use."
    >
      {!narrative ? (
        <p className="text-sm text-muted-foreground">
          Generate a narrative to record a trace. Until then the page shows deterministic advisories
          computed by the database.
        </p>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={configured ? "success" : "warning"}>
              {configured
                ? "AI provider responded"
                : narrative.status === "not_configured"
                  ? "No AI provider configured"
                  : "AI unavailable"}
            </StatusPill>
            <StatusPill tone="info">{trace?.provider ?? "none"}</StatusPill>
            <span className="text-muted-foreground">
              {configured ? (trace?.model ?? "unnamed model") : "System advisory (deterministic)"}
            </span>
          </div>

          <dl className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Generated</dt>
              <dd>{trace ? new Date(trace.generated_at).toLocaleString() : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Generation time</dt>
              <dd>{trace ? `${trace.duration_ms} ms` : "—"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Source of truth</dt>
              <dd>{trace?.source ?? "neo_intelligence"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Values supplied</dt>
              <dd>{trace?.input_count ?? 0}</dd>
            </div>
          </dl>

          {narrative.detail ? (
            <p className="text-xs text-muted-foreground">{narrative.detail}</p>
          ) : null}

          {trace && trace.inputs.length > 0 ? (
            <details className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-xs font-medium">
                Deterministic values used ({trace.inputs.length})
              </summary>
              <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
                {trace.inputs.map((i) => (
                  <li key={i.label} className="flex justify-between gap-3">
                    <span className="text-muted-foreground">{i.label}</span>
                    <span className="tabular-nums">{i.value}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

const severityTone = (s: Anomaly["severity"]) =>
  s === "critical" ? "destructive" : s === "warning" ? "warning" : "info";

function IntelligencePage() {
  // The global header is the single source of property context. Intelligence
  // inherits it and never offers a second, competing selector.
  const branchScope = useBranchScope();
  const globalBranchId = branchScope.activeBranchId === "all" ? null : branchScope.activeBranchId;
  const { scope: dateScope, setScope: setDateScope } = useAnalyticsScope();
  const scope = useMemo(
    () => ({ ...dateScope, branchId: globalBranchId }),
    [dateScope, globalBranchId],
  );
  const setScope = (s: typeof scope) => setDateScope({ ...s, branchId: globalBranchId });
  const intel = useIntelligence({ branchId: scope.branchId, from: scope.from, to: scope.to });
  const myWork = useMyWork(globalBranchId);

  const runNarrative = useServerFn(generateBriefingNarrative);
  const [narrative, setNarrative] = useState<Narrative | null>(null);
  const [generating, setGenerating] = useState(false);

  const [mode, setMode] = useState<IntelligenceMode>("my-work");
  const [commandOpen, setCommandOpen] = useState(false);
  const [investigating, setInvestigating] = useState<string | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[]>([]);
  const [asking, setAsking] = useState(false);
  const runAsk = useServerFn(askNeo);
  useCommandShortcut(setCommandOpen);

  const data = intel.data;
  const ready = Boolean(data) && !intel.isLoading && !intel.error;
  const activeSection = useIntelligenceScrollSpy(ready && mode === "explore");
  const currency = data?.currency ?? "";
  const brief = data?.briefing ?? {};
  const moneyVisible = data?.money_visible === true;

  // Comparison window: the immediately preceding period of the same length.
  const comparison = priorPeriod(scope.from, scope.to);
  const priorIntel = useIntelligence(
    { branchId: scope.branchId, from: comparison.from, to: comparison.to },
    mode === "today" || mode === "discoveries",
  );

  const propertyLabel =
    branchScope.activeBranch?.name ?? (globalBranchId ? "Selected property" : "All permitted properties");

  const answerScope = scopeOf(data, propertyLabel);
  // Role-specific intelligence: the engine is identical for everyone, the
  // reach is not. Findings, evidence links and monetary values are reduced to
  // what this person's effective permissions already allow them to open.
  const visibility = useVisibility();
  const isMobile = useIsMobile();
  const viewer = useMemo(
    () => ({
      canSeePage: (path: string) => visibility.canSeePage(path),
      canSeeMoney: moneyVisible && visibility.canSeeCost("financial-statements"),
    }),
    [visibility, moneyVisible],
  );
  const lens = useMemo(() => lensFor(viewer), [viewer]);

  const discoveries = useMemo(
    () => scopeDiscoveries(buildDiscoveries(data), viewer),
    [data, viewer],
  );
  const changes = useMemo(
    () => scopeChanges(buildChanges(data, priorIntel.data), viewer),
    [data, priorIntel.data, viewer],
  );
  const briefItems = useMemo(() => buildBrief(discoveries, changes), [discoveries, changes]);
  // Progress is reported on the same evidence as risk, so the briefing is not
  // only a list of problems.
  const positives = useMemo(
    () => buildPositives(data, changes, discoveries),
    [data, changes, discoveries],
  );
  const decisions = useMemo(() => scopeDecisions(buildDecisions(data), viewer), [data, viewer]);
  // Editorial weighting: one dominant story, a few supporting, the rest folded away.
  const leadDiscovery = discoveries[0] ?? null;
  const supportingDiscoveries = discoveries.slice(1, 4);
  const routineDiscoveries = discoveries.slice(4);
  const investigation = investigating ? buildInvestigation(investigating, data, answerScope) : null;
  const activeModules: NeoModule[] = Array.from(
    new Set(discoveries.slice(0, 6).flatMap((d) => d.modules)),
  );

  /** Sends one question through the authenticated, scope-bound server function. */
  async function ask(question: string) {
    const id = `${Date.now()}-${turns.length}`;
    setTurns((prev) => [
      { id, question, answer: null, narrative: null, narrativeStatus: null, pending: true, error: null },
      ...prev,
    ]);
    setAsking(true);
    try {
      const result = await runAsk({
        data: {
          question,
          branchId: scope.branchId,
          from: scope.from,
          to: scope.to,
          propertyLabel,
        },
      });
      setTurns((prev) =>
        prev.map((t) =>
          t.id === id
            ? result.ok
              ? {
                  ...t,
                  pending: false,
                  answer: result.answer,
                  narrative: result.narrative,
                  narrativeStatus: result.narrativeStatus,
                }
              : { ...t, pending: false, error: "Please enter a question." }
            : t,
        ),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "NEØ could not answer that request.";
      setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, pending: false, error: message } : t)));
      toast.error(message);
    } finally {
      setAsking(false);
    }
  }


  // Not everyone holds executive intelligence rights. Those people still get
  // NEØ — reduced to their own work, built entirely from permitted records.
  if (data && data.authorised === false) {
    return (
      <div>
        <PageHeader
          eyebrow="Intelligence"
          title="NEØ Intelligence"
          description="Your work, in the property the header is working in."
        />
        {data.reason === "no_organisation" || myWork.data?.authorised === false ? (
          <AccessDeniedPanel
            reason={data.reason === "no_organisation" ? "setup" : "denied"}
            subject="NEØ Intelligence"
          />
        ) : myWork.isLoading ? (
          <LoadingState variant="cards" rows={3} />
        ) : myWork.error ? (
          <ErrorState error={myWork.error} title="My work unavailable" />
        ) : (
          <MyWorkBoard
            items={myWork.data?.items ?? []}
            propertyLabel={propertyLabel}
            today={myWork.data?.today}
            lensNote="NEØ shows only the areas your permissions already reach."
          />
        )}
      </div>
    );
  }


  const num = (k: string) =>
    brief[k] === null || brief[k] === undefined ? null : Number(brief[k]);

  const history = (data?.demand?.history ?? []).map((p) => ({
    day: String(p.day).slice(5),
    occupancy: p.occupancy ?? null,
  }));
  const forward = (data?.demand?.forward ?? []).map((p) => ({
    day: String(p.day).slice(5),
    onBooks: Number(p.on_the_books ?? 0),
    sellable: Number(p.sellable ?? 0),
  }));

  const anomalies = data?.anomalies ?? [];
  const criticalCount = anomalies.filter((a) => a.severity === "critical").length;

  async function handleNarrative() {
    setGenerating(true);
    try {
      const result = (await runNarrative({
        data: { branchId: scope.branchId, from: scope.from, to: scope.to },
      })) as Narrative;
      setNarrative(result);
      if (result.status === "not_configured")
        toast.info("No AI provider is configured — showing System advisories.");
      else if (result.status !== "ok")
        toast.warning(result.detail ?? "AI is unavailable — showing System advisories.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Narrative unavailable");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Intelligence"
        title="NEØ Intelligence"
        description="Seven scoped sections built from operational records inside your permitted properties and period. Nothing is estimated, and no advisory changes live data."
      />

      <ScopeBar
        scope={scope}
        onChange={setScope}
        lockedPropertyLabel={propertyLabel}
        note={
          data?.generated_at
            ? `Generated ${new Date(data.generated_at).toLocaleString()} · ${data.timezone ?? ""}`
            : ""
        }
      />


      {intel.isLoading ? (
        <LoadingState variant="cards" rows={4} />
      ) : intel.error ? (
        <ErrorState error={intel.error} title="Intelligence unavailable" />
      ) : (
        <div className="space-y-6">
          <AiUnavailableBanner status={narrative?.status} detail={narrative?.detail} />

          <IntelligenceHero
            period={`${data?.period?.from ?? "—"} → ${data?.period?.to ?? "—"}`}
            generatedAt={data?.generated_at}
            timezone={data?.timezone ?? undefined}
            confidence={data?.demand?.confidence ?? "insufficient"}
            signals={[
              {
                label: "Occupancy",
                value: percent(num("occupancy_rate")),
                hint: `${count(num("sellable_rooms"))} sellable rooms`,
              },
              {
                label: moneyVisible ? "Recognised revenue" : "Revenue",
                value: moneyVisible ? money(num("net_recognised_revenue"), currency) : "Restricted",
                hint: moneyVisible ? "Posted, net of reversals" : "Finance access required",
              },
              {
                label: "Guest rating",
                value:
                  data?.sentiment?.average_rating != null
                    ? data.sentiment.average_rating.toFixed(2)
                    : "—",
                hint: `${count(data?.sentiment?.responses)} response(s)`,
              },
              {
                label: "Open risks",
                value: count(anomalies.length),
                hint: `${criticalCount} critical · ${count(num("pending_approvals"))} approvals waiting`,
              },
            ]}
          />

          <ModeNav
            mode={mode}
            onChange={setMode}
            onOpenCommand={() => setCommandOpen(true)}
            counts={{ discoveries: discoveries.length, decisions: decisions.length }}
            context={`${lens.label} · ${propertyLabel} · ${data?.period?.from ?? "—"} → ${data?.period?.to ?? "—"} · compared to the previous period`}
            discovered={
              discoveries.length > 0
                ? `NEØ found ${discoveries.length} thing${discoveries.length === 1 ? "" : "s"}`
                : null
            }
          />

          <CommandOverlay
            open={commandOpen}
            onOpenChange={setCommandOpen}
            onMode={setMode}
            onAsk={(q) => {
              setMode("ask");
              void ask(q);
            }}
          />

          {investigation ? (
            <InvestigationPane investigation={investigation} onClose={() => setInvestigating(null)} />
          ) : null}

          {mode === "my-work" ? (
            myWork.isLoading ? (
              <LoadingState variant="cards" rows={3} />
            ) : myWork.error ? (
              <ErrorState error={myWork.error} title="My work unavailable" />
            ) : (
              <MyWorkBoard
                items={myWork.data?.items ?? []}
                propertyLabel={propertyLabel}
                today={myWork.data?.today}
                lensNote={lens.note}
              />
            )
          ) : null}

          {mode === "today" && isMobile ? (

            <div className="space-y-4" data-testid="intelligence-mobile">
              <p className="text-xs text-muted-foreground">{lens.note}</p>
              {discoveries.length === 0 ? (
                <AbsenceState
                  title="Nothing needs your attention in this scope"
                  meaning="No detection rule matched the operational records your permissions reach for this property and period."
                  actions={[{ label: "Review operational tasks", to: "/tasks" }]}
                />
              ) : (
                <SwipeableBrief discoveries={discoveries} onInvestigate={setInvestigating} />
              )}
              {positives.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    What is going well
                  </p>
                  <WhatsGoingWell positives={positives} />
                </div>
              ) : null}

              <div className="neo-ask-bar min-w-0 rounded-2xl border border-outline-subtle p-3">
                <p className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Ask NEØ
                </p>
                <AskComposer onAsk={(q) => { setMode("ask"); void ask(q); }} busy={asking} compact />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <VoiceAskButton onResult={(q) => { setMode("ask"); void ask(q); }} />
                  <GraphFullscreen
                    viz={
                      history.length > 1
                        ? {
                            kind: "area",
                            title: "Occupancy through this period",
                            xKey: "day",
                            unit: "percent",
                            series: [{ key: "occupancy", label: "Occupancy %" }],
                            data: history,
                          }
                        : null
                    }
                    label="Full-screen occupancy"
                  />
                </div>
              </div>

              <RecommendedAction decision={decisions[0] ?? null} />
              <IntelligenceTrace narrative={narrative} />
            </div>
          ) : null}

          {mode === "today" && !isMobile ? (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="min-w-0 space-y-5">
                <EditorialOpening attention={briefItems.length} scope={answerScope} />

                {leadDiscovery ? (
                  <LeadStory
                    discovery={leadDiscovery}
                    onInvestigate={setInvestigating}
                    {...(history.length > 1
                      ? {
                          chart: (
                            <VizRenderer
                              viz={{
                                kind: "area",
                                title: "Occupancy through this period",
                                xKey: "day",
                                unit: "percent",
                                series: [{ key: "occupancy", label: "Occupancy %" }],
                                data: history,
                              }}
                            />
                          ),
                        }
                      : {})}
                  />
                ) : (
                  <AbsenceState
                    title="Nothing needs your attention in this scope"
                    meaning="No detection rule matched the operational records for this property and period. NEØ does not manufacture a briefing to fill the space."
                    actions={[
                      { label: "Review operational tasks", to: "/tasks" },
                      { label: "Open Finance posting", to: "/finance/posting" },
                    ]}
                  />
                )}

                <SupportingFindings discoveries={supportingDiscoveries} onInvestigate={setInvestigating} />

                <div className="neo-ask-bar rounded-2xl border border-outline-subtle p-3">
                  <p className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Ask NEØ
                  </p>
                  <AskComposer onAsk={(q) => { setMode("ask"); void ask(q); }} busy={asking} compact />
                  <div className="mt-3">
                    <SuggestedQuestions onAsk={(q) => { setMode("ask"); void ask(q); }} busy={asking} />
                  </div>
                </div>

                <RoutineDisclosure label="What is going well" count={positives.length}>
                  <WhatsGoingWell positives={positives} />
                </RoutineDisclosure>

                <RoutineDisclosure label="What changed against the previous period" count={changes.filter((c) => c.material).length}>
                  <WhatChanged changes={changes} loading={priorIntel.isLoading} />
                </RoutineDisclosure>

                <RoutineDisclosure label="Everything else NEØ noticed" count={routineDiscoveries.length}>
                  {routineDiscoveries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing further was detected in this scope.</p>
                  ) : (
                    <ul className="grid gap-3 xl:grid-cols-2">
                      {routineDiscoveries.map((d) => (
                        <li key={d.id} className="min-w-0">
                          <DiscoveryCard discovery={d} onInvestigate={setInvestigating} />
                        </li>
                      ))}
                    </ul>
                  )}
                </RoutineDisclosure>
              </div>

              <div className="min-w-0 space-y-4">
                <NeoBrain active={activeModules} />
                <IntelligenceTrace narrative={narrative} />
              </div>
            </div>
          ) : null}

          {mode === "ask" ? (
            <div className="space-y-4">
              <AskComposer onAsk={(q) => void ask(q)} busy={asking} />
              <SuggestedQuestions onAsk={(q) => void ask(q)} busy={asking} />
              {turns.length === 0 ? (
                <AbsenceState
                  title="NEØ is ready when you are"
                  meaning="NEØ answers only from operational records inside your permitted properties and the selected period. It never invents a figure and never changes anything."
                />
              ) : (
                <div className="space-y-4">
                  {turns.map((t) => (
                    <AnswerCard key={t.id} turn={t} onAsk={(q) => void ask(q)} />
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {mode === "discoveries" ? (
            <SectionCard
              title="NEØ noticed"
              description="Ranked by severity, size and how actionable each finding is. Every line is evidenced."
            >
              {discoveries.length === 0 ? (
                <AbsenceState
                  title="No discovery in this scope"
                  meaning="No detection rule matched the operational records for this property and period. That is a statement about the records, not a clean bill of health."
                  actions={[{ label: "Review operational tasks", to: "/tasks" }]}
                />
              ) : (
                <ul className="grid gap-3 xl:grid-cols-2">
                  {discoveries.map((d) => (
                    <li key={d.id} className="min-w-0">
                      <DiscoveryCard discovery={d} onInvestigate={setInvestigating} />
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          ) : null}

          {mode === "decisions" ? (
            <div className="space-y-4">
              <SectionCard
                title="NEØ recommends"
                description="Prepared cases with evidence, confidence and alternatives. NEØ never applies any of them."
              >
                {decisions.length === 0 ? (
                  <AbsenceState
                    title="No decision to prepare"
                    meaning="A decision is only offered when the underlying records support it. Nothing in this scope met that bar."
                  />
                ) : (
                  <ul className="grid gap-3 xl:grid-cols-2">
                    {decisions.map((d) => (
                      <li key={d.id} className="min-w-0">
                        <DecisionCard decision={d} />
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              <ScenarioSimulator
                sellable={num("sellable_rooms")}
                averageValue={
                  num("net_recognised_revenue") !== null && num("sellable_rooms")
                    ? Math.round(
                        (num("net_recognised_revenue") as number) /
                          Math.max(1, Math.round(((num("sellable_rooms") as number) * (num("occupancy_rate") ?? 0)) / 100)),
                      )
                    : null
                }
                currency={currency}
                moneyVisible={moneyVisible}
                baselineOccupancy={num("occupancy_rate")}
              />
            </div>
          ) : null}

          {mode === "explore" && (
            <>
          <IntelligenceRail active={activeSection} />

          {/* ---------- 01 Executive Pulse ---------- */}
          <IntelligenceSection
            id="executive-pulse"
            index={1}
            title="Executive Pulse"
            description={`Today's operating position for ${data?.period?.from ?? "—"} → ${data?.period?.to ?? "—"}.`}
          >
            <SectionCard title="Front office & operations" description="Rooms, arrivals and work in hand.">
              <MetricGrid>
                <MetricTile
                  label="Occupancy"
                  value={percent(num("occupancy_rate"))}
                  hint={`${count(num("sellable_rooms"))} sellable rooms`}
                />
                <MetricTile
                  label="Arrivals today"
                  value={count(num("arrivals_today"))}
                  hint={`${count(num("departures_today"))} departures`}
                />
                <MetricTile
                  label="Rooms unavailable"
                  value={count(num("unavailable_rooms"))}
                  hint="Blocked, out of order or not sellable"
                />
                <MetricTile
                  label="Overdue tasks"
                  value={count(num("overdue_tasks"))}
                  hint={`${count(num("pending_approvals"))} approvals waiting`}
                />
              </MetricGrid>
            </SectionCard>

            <SectionCard
              title={narrative?.status === "ok" ? "AI narrative (interpretation)" : "System advisories"}
              description={
                narrative?.status === "ok"
                  ? `Written by ${narrative.model ?? "the configured model"} from the figures above only.`
                  : "Deterministic summary of the figures above. No model was used."
              }
              actions={
                <Button size="sm" variant="outline" onClick={handleNarrative} disabled={generating}>
                  <Sparkles className="size-4" /> {generating ? "Writing…" : "Generate narrative"}
                </Button>
              }
            >
              {narrative?.status === "ok" && narrative.text ? (
                <p className="whitespace-pre-line text-sm">{narrative.text}</p>
              ) : (
                <ul className="divide-y divide-outline-subtle">
                  {(data?.departments ?? []).map((d) => (
                    <li
                      key={d.department}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{d.department}</p>
                        <p className="text-sm leading-snug text-muted-foreground">{d.headline}</p>
                      </div>
                      <Button asChild size="sm" variant="ghost" className="shrink-0">
                        <Link to={d.drill_to}>Open</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}

              {narrative && narrative.status !== "ok" ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {narrative.status === "not_configured"
                    ? "No AI provider is configured for this workspace, so NEØ shows the deterministic advisories instead of generated text."
                    : (narrative.detail ??
                      "AI temporarily unavailable — deterministic advisories shown.")}
                </p>
              ) : null}
            </SectionCard>

            <IntelligenceTrace narrative={narrative} />
          </IntelligenceSection>

          {/* ---------- 02 Revenue & Demand ---------- */}
          <IntelligenceSection
            id="revenue-demand"
            index={2}
            title="Revenue & Demand"
            description="Recognised, collected and committed value against forward demand."
          >
            <SectionCard title="Financial position" description="Same period, same property scope.">
              <MetricGrid>
                {moneyVisible ? (
                  <>
                    <MetricTile
                      label="Recognised revenue"
                      value={money(num("net_recognised_revenue"), currency)}
                      hint="Posted, net of reversals"
                    />
                    <MetricTile
                      label="Finalised POS sales"
                      value={money(num("pos_finalised_sales"), currency)}
                      hint="Settled orders only"
                    />
                    <MetricTile
                      label="Open POS value"
                      value={money(num("pos_open_value"), currency)}
                      hint="Operational value — not revenue"
                    />
                    <MetricTile
                      label="Collected"
                      value={money(num("collected"), currency)}
                      hint={`Receivables ${money(num("receivables"), currency)}`}
                    />
                    <MetricTile
                      label="Confirmed event forecast"
                      value={money(num("event_confirmed_forecast"), currency)}
                      hint="Forecast — not recognised"
                    />
                    <MetricTile
                      label="Provisional event forecast"
                      value={money(num("event_provisional_forecast"), currency)}
                      hint="Pipeline only"
                    />
                  </>
                ) : (
                  <InsetPanel className="col-span-full text-sm text-muted-foreground">
                    Financial values are hidden because your roles do not include finance, analytics
                    or reporting access.
                  </InsetPanel>
                )}
              </MetricGrid>
            </SectionCard>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                <MetricTile
                  label="Average occupancy"
                  value={percent(data?.demand?.average_occupancy ?? null)}
                  hint={`${count(data?.demand?.sample_days)} day(s) with recorded occupancy`}
                  icon={Gauge}
                  tone={data?.demand?.sufficient ? "success" : "warning"}
                />
                <MetricTile
                  label="Forecast confidence"
                  dense
                  value={
                    data?.demand?.confidence === "high"
                      ? "High"
                      : data?.demand?.confidence === "moderate"
                        ? "Moderate"
                        : "Insufficient history"
                  }
                  hint={data?.demand?.method ?? ""}
                />
              </div>

              <ChartCard
                title="Demand & occupancy"
                subtitle="Occupancy % by day · selected period"
                series={[{ label: "Occupancy %", color: chartSeriesColor(0), kind: "area" }]}
                source="neo_intelligence · ops_room_state"
                empty={history.length === 0}
                emptyTitle="No occupancy history in this period"
                emptyDescription="Occupancy is only charted from recorded room states — nothing is interpolated."
              >
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={history} margin={{ left: -18, right: 8, top: 6 }}>
                    <ChartGradients idPrefix="neoi" />
                    <CartesianGrid {...GRID_PROPS} />
                    <XAxis dataKey="day" {...AXIS_PROPS} minTickGap={16} />
                    <YAxis {...AXIS_PROPS} unit="%" width={38} domain={[0, 100]} />
                    <Tooltip
                      {...TOOLTIP_PROPS}
                      formatter={(v: number | string) => [`${v}%`, "Occupancy"]}
                    />
                    <Area
                      {...LINE_PROPS}
                      dataKey="occupancy"
                      name="Occupancy"
                      stroke={chartSeriesColor(0)}
                      fill={chartFill(0, "neoi")}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>

            <SectionCard
              title="Next 14 days on the books"
              description="Forward reservations against sellable rooms, by arrival date."
            >
              {forward.length === 0 ? (
                <p className="text-sm text-muted-foreground">No forward reservations recorded.</p>
              ) : (
                <TableScroll>
                  <table className="w-full min-w-[34rem] text-sm">
                    <thead>
                      <tr className="sticky top-0 z-[1] border-b border-border bg-card text-left text-xs uppercase text-muted-foreground">
                        <th className="neo-sticky-col py-2 pr-3">Date</th>
                        <th className="py-2">On the books</th>
                        <th className="py-2">Sellable</th>
                        <th className="py-2">Pace</th>
                      </tr>
                    </thead>
                    <tbody>
                      {forward.map((r) => (
                        <tr key={r.day} className="border-b border-border/60">
                          <td className="neo-sticky-col py-2 pr-3">{r.day}</td>
                          <td className="py-2 tabular-nums">{r.onBooks}</td>
                          <td className="py-2 tabular-nums">{r.sellable}</td>
                          <td className="py-2 tabular-nums">
                            {r.sellable > 0
                              ? `${((r.onBooks * 100) / r.sellable).toFixed(0)}%`
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </SectionCard>
          </IntelligenceSection>

          {/* ---------- 03 Guest Experience ---------- */}
          <IntelligenceSection
            id="guest-experience"
            index={3}
            title="Guest Experience"
            description="Rated feedback received in this period, by theme."
          >
            <SectionCard title="Guest sentiment" description={data?.sentiment?.note ?? ""}>
              <MetricGrid className="mb-3">
                <MetricTile label="Responses" value={count(data?.sentiment?.responses)} />
                <MetricTile
                  label="Average rating"
                  value={
                    data?.sentiment?.average_rating != null
                      ? data.sentiment.average_rating.toFixed(2)
                      : "—"
                  }
                />
                <MetricTile
                  label="Ratings of 2 or below"
                  value={count(data?.sentiment?.detractors)}
                />
              </MetricGrid>
              {(data?.sentiment?.themes ?? []).length === 0 ? (
                <AwaitingData
                  title="No rated feedback in this period"
                  detail="Sentiment is only reported from feedback records actually received — nothing is inferred."
                />
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {(data?.sentiment?.themes ?? []).map((t) => (
                    <li
                      key={t.category}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="min-w-0">{t.category}</span>
                      <span className="numeric text-muted-foreground">
                        {t.responses} response(s) · avg {t.average_rating}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </IntelligenceSection>

          {/* ---------- 04 Operational Risk ---------- */}
          <IntelligenceSection
            id="operational-risk"
            index={4}
            title="Operational Risk"
            description="Patterns worth reviewing, each with the records behind it. Observations, never accusations."
            aside={
              <StatusPill tone={criticalCount > 0 ? "destructive" : "info"}>
                {count(anomalies.length)} open signal(s)
              </StatusPill>
            }
          >
            <SectionCard title="Control exceptions" description="Unposted, failed and blocked work.">
              <MetricGrid>
                <MetricTile
                  label="Unposted eligible records"
                  value={count(num("unmatched_eligible"))}
                  hint="Awaiting Finance posting"
                />
                <MetricTile
                  label="Failed postings"
                  value={count(num("failed_postings"))}
                  hint="Require an authorised recovery action"
                />
                <MetricTile
                  label="Failed workflows"
                  value={count(num("failed_workflows"))}
                  hint="Unresolved automation failures"
                />
                <MetricTile
                  label="Approvals waiting"
                  value={count(num("pending_approvals"))}
                  hint="Pending or executing"
                />
              </MetricGrid>
            </SectionCard>

            <SectionCard
              title="Anomaly monitoring"
              description="Each signal links to the operational records that produced it."
            >
              {anomalies.length === 0 ? (
                <AwaitingData
                  title="No anomalies detected"
                  detail="Nothing in this property and period met an anomaly rule."
                />
              ) : (
                <ul className="grid gap-3 lg:grid-cols-2">
                  {anomalies.map((a) => (
                    <li
                      key={a.key}
                      data-severity={a.severity}
                      className={
                        "surface-quiet neo-card-pad flex min-w-0 flex-col gap-2 border-l-[3px] " +
                        (a.severity === "critical"
                          ? "border-l-destructive"
                          : a.severity === "warning"
                            ? "border-l-warning"
                            : "border-l-primary/50")
                      }
                    >
                      <div className="flex min-w-0 items-start gap-2">
                        {a.severity === "warning" || a.severity === "critical" ? (
                          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                        ) : (
                          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground">{a.title}</p>
                          <p className="mt-0.5 text-sm leading-snug text-muted-foreground">
                            {a.detail}
                          </p>
                          <p className="mt-1 text-xs leading-snug text-muted-foreground">
                            {a.evidence}
                          </p>
                        </div>
                      </div>
                      <div
                        data-action-cluster
                        className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1"
                      >
                        <StatusPill tone={severityTone(a.severity)}>{a.severity}</StatusPill>
                        <Button asChild size="sm" variant="outline">
                          <Link to={a.drill_to}>Review records</Link>
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </IntelligenceSection>

          {/* ---------- 05 Cost & Inventory ---------- */}
          <IntelligenceSection
            id="cost-inventory"
            index={5}
            title="Cost & Inventory"
            description="Recipe costing coverage and menu margin, plus supplier obligations."
          >
            {moneyVisible ? (
              <SectionCard title="Supplier obligations" description="Approved commitments in scope.">
                <MetricGrid>
                  <MetricTile
                    label="Payables"
                    value={money(num("payables"), currency)}
                    hint="Approved supplier obligations"
                  />
                </MetricGrid>
              </SectionCard>
            ) : null}

            <SectionCard title="Menu & recipe profitability" description={data?.menu?.note ?? ""}>
              <MetricGrid className="mb-3">
                <MetricTile label="Menu items" value={count(data?.menu?.items_total)} />
                <MetricTile label="With costed recipe" value={count(data?.menu?.items_costed)} />
                <MetricTile
                  label="Cost coverage"
                  value={percent(data?.menu?.coverage_percent ?? null)}
                />
              </MetricGrid>
              {(data?.menu?.items ?? []).length === 0 ? (
                <AwaitingData
                  title="No costed menu item yet"
                  detail="A margin is only reported when a menu item has both a price and a costed recipe."
                />
              ) : (
                <TableScroll>
                  <table className="w-full min-w-[34rem] text-sm">
                    <thead>
                      <tr className="sticky top-0 z-[1] border-b border-border bg-card text-left text-xs uppercase text-muted-foreground">
                        <th className="py-2">Item</th>
                        <th className="py-2">Price</th>
                        <th className="py-2">Portion cost</th>
                        <th className="py-2">Margin</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.menu?.items ?? []).map((m) => (
                        <tr key={m.item} className="border-b border-border/60">
                          <td className="py-2">{m.item}</td>
                          <td className="py-2 tabular-nums">{money(m.price, currency)}</td>
                          <td className="py-2 tabular-nums">{money(m.cost, currency)}</td>
                          <td className="py-2 tabular-nums">{percent(m.margin_percent ?? null)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </SectionCard>
          </IntelligenceSection>

          {/* ---------- 06 Workforce ---------- */}
          <IntelligenceSection
            id="workforce"
            index={6}
            title="Workforce"
            description="Work in hand and readiness signals available from operational records."
          >
            <SectionCard title="Work readiness" description="Derived from tasks and approvals in scope.">
              <MetricGrid>
                <MetricTile
                  label="Overdue tasks"
                  value={count(num("overdue_tasks"))}
                  hint="Past due and not completed"
                />
                <MetricTile
                  label="Approvals waiting"
                  value={count(num("pending_approvals"))}
                  hint="Blocking downstream work"
                />
              </MetricGrid>
              <AwaitingData
                title="Rostered coverage not yet reported"
                detail="Shift, attendance and station coverage figures will appear here once scheduling records exist for this property and period. NEØ does not estimate workforce coverage."
              />
            </SectionCard>
          </IntelligenceSection>

          {/* ---------- 07 Recommendations ---------- */}
          <IntelligenceSection
            id="recommendations"
            index={7}
            title="Recommendations"
            description="Advisory only. NEØ never changes or publishes a rate, and never acts on your behalf."
          >
            <SectionCard
              title="Rate suggestions (advisory only)"
              description="Each line shows the published plan against forward demand so a human can decide."
            >
              {(data?.rate_suggestions ?? []).length === 0 ? (
                <AwaitingData
                  title="No advisory available"
                  detail="No active room type with a published rate plan is in scope."
                />
              ) : (
                <TableScroll>
                  <table className="w-full min-w-[34rem] text-sm">
                    <thead>
                      <tr className="sticky top-0 z-[1] border-b border-border bg-card text-left text-xs uppercase text-muted-foreground">
                        <th className="neo-sticky-col py-2 pr-3">Room type</th>
                        <th className="py-2">Rate plan</th>
                        <th className="py-2">Current rate</th>
                        <th className="py-2">Sellable rooms</th>
                        <th className="py-2">On books (14d)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.rate_suggestions ?? []).map((r) => (
                        <tr
                          key={`${r.room_type}-${r.rate_plan ?? "none"}`}
                          className="border-b border-border/60"
                        >
                          <td className="neo-sticky-col py-2 pr-3 font-medium">{r.room_type}</td>
                          <td className="py-2 text-muted-foreground">
                            {r.rate_plan ?? "No active plan"}
                          </td>
                          <td className="py-2 tabular-nums">
                            {moneyVisible ? money(r.current_rate, currency) : "—"}
                          </td>
                          <td className="py-2 tabular-nums">{r.rooms_of_type}</td>
                          <td className="py-2 tabular-nums">{r.on_the_books_next_14}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              )}
            </SectionCard>

            <SectionCard
              title="Departmental advisories"
              description="Deterministic headlines with a direct route to the underlying records."
            >
              {(data?.departments ?? []).length === 0 ? (
                <AwaitingData
                  title="No departmental advisory"
                  detail="Advisories appear once departmental records exist for this property and period."
                />
              ) : (
                <ul className="divide-y divide-outline-subtle">
                  {(data?.departments ?? []).map((d) => (
                    <li
                      key={`rec-${d.department}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{d.department}</p>
                        <p className="text-sm leading-snug text-muted-foreground">{d.headline}</p>
                      </div>
                      <Button asChild size="sm" variant="outline" className="shrink-0">
                        <Link to={d.drill_to}>Open records</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </IntelligenceSection>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/ai-insights">
      <IntelligencePage />
    </OpsGuard>
  );
}
