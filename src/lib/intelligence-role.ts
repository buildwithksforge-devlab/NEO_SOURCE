/**
 * Role-specific intelligence.
 *
 * The same deterministic engine runs for everybody; what differs is what the
 * signed-in person is *permitted* to see. A finding whose only module is one
 * the viewer cannot open is not shown, an evidence line that would link into a
 * forbidden route keeps the line but drops the link, and a recorded monetary
 * value is withheld unless the viewer holds the matching cost capability.
 *
 * Access is decided by effective permissions only — never by role name. The
 * lens label below is derived from the capabilities a person actually holds,
 * so a custom role behaves correctly with no code change.
 */
import type {
  ChangeItem,
  Decision,
  Discovery,
  Evidence,
  NeoModule,
} from "@/lib/intelligence-types";

export type IntelligenceViewer = {
  /** Page visibility test from the visibility contract. */
  canSeePage: (path: string) => boolean;
  /** Confidential-figure test from the visibility contract. */
  canSeeMoney: boolean;
};

/** Canonical home route for each intelligence module. */
export const MODULE_HOME: Record<NeoModule, string> = {
  pms: "/pms/reservations",
  crm: "/crm/guests",
  pos: "/pos/orders",
  kitchen: "/kitchen/queue",
  inventory: "/inventory/items",
  procurement: "/procurement/orders",
  finance: "/finance/posting",
  housekeeping: "/housekeeping/tasks",
  events: "/events",
  workforce: "/tasks",
  delivery: "/delivery/dispatch",
};

/** The modules this viewer may actually work in. */
export function permittedModules(viewer: IntelligenceViewer): NeoModule[] {
  return (Object.keys(MODULE_HOME) as NeoModule[]).filter((m) =>
    viewer.canSeePage(MODULE_HOME[m]),
  );
}

/**
 * A human label for the lens NEØ is speaking through, resolved from
 * capabilities rather than titles. It is descriptive only: it never grants or
 * withholds anything by itself.
 */
export function lensFor(viewer: IntelligenceViewer): { label: string; note: string } {
  const modules = permittedModules(viewer);
  const has = (m: NeoModule) => modules.includes(m);
  if (modules.length === 0)
    return {
      label: "Personal view",
      note: "NEØ is showing only what your current permissions reach.",
    };
  if (viewer.canSeeMoney && has("finance") && has("pms") && has("pos"))
    return {
      label: "Management view",
      note: "You hold cross-module and financial access, so NEØ reports the whole operating position.",
    };
  if (viewer.canSeeMoney && has("finance"))
    return {
      label: "Finance view",
      note: "NEØ leads with posting, collection and receivable evidence you are permitted to act on.",
    };
  if (has("pos") || has("kitchen"))
    return {
      label: "Service view",
      note: "NEØ reports the service position for the areas you work in. Financial totals are withheld.",
    };
  if (has("housekeeping") || has("pms"))
    return {
      label: "Front-of-house view",
      note: "NEØ reports room readiness and arrival pressure inside your permitted scope.",
    };
  return {
    label: "Operational view",
    note: "NEØ reports only the modules your permissions reach.",
  };
}

/** Keeps the evidence line but removes a link the viewer cannot follow. */
export function scopeEvidence(evidence: Evidence[], viewer: IntelligenceViewer): Evidence[] {
  return evidence.map((e) => {
    if (!e.drillTo || viewer.canSeePage(e.drillTo)) return e;
    const { drillTo: _drop, ...rest } = e;
    return rest;
  });
}

const reachable = (viewer: IntelligenceViewer, modules: NeoModule[], drillTo?: string) => {
  if (drillTo && viewer.canSeePage(drillTo)) return true;
  return modules.some((m) => viewer.canSeePage(MODULE_HOME[m]));
};

/** Discoveries the viewer may see, with money and links reduced to their rights. */
export function scopeDiscoveries(
  discoveries: Discovery[],
  viewer: IntelligenceViewer,
): Discovery[] {
  return discoveries
    .filter((d) => reachable(viewer, d.modules, d.drillTo))
    .map((d) => {
      const next: Discovery = {
        ...d,
        evidence: scopeEvidence(d.evidence, viewer),
      };
      if (!viewer.canSeeMoney && next.impact) {
        next.impact = null;
        next.impactNote = "Monetary value withheld — your permissions do not include financial figures.";
      }
      if (next.drillTo && !viewer.canSeePage(next.drillTo)) delete next.drillTo;
      return next;
    });
}

export function scopeDecisions(decisions: Decision[], viewer: IntelligenceViewer): Decision[] {
  return decisions
    .filter((d) => (d.action ? viewer.canSeePage(d.action.to) : true))
    .map((d) => ({ ...d, evidence: scopeEvidence(d.evidence, viewer) }));
}

export function scopeChanges(changes: ChangeItem[], viewer: IntelligenceViewer): ChangeItem[] {
  return changes
    .filter((c) => (c.unit === "money" ? viewer.canSeeMoney : true))
    .filter((c) => reachable(viewer, c.modules))
    .map((c) => ({ ...c, evidence: scopeEvidence(c.evidence, viewer) }));
}
