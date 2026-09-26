/**
 * NEØ Intelligence — shared object model.
 *
 * These types describe what Intelligence is allowed to say and how it must
 * justify it. Every statement carries a kind (fact / calculation / comparison /
 * forecast / recommendation / limitation) and every insight carries evidence
 * that points at business records — never at model reasoning.
 */

export type StatementKind =
  | "fact"
  | "calculation"
  | "comparison"
  | "forecast"
  | "recommendation"
  | "limitation";

export const STATEMENT_LABEL: Record<StatementKind, string> = {
  fact: "Fact",
  calculation: "Calculation",
  comparison: "Comparison",
  forecast: "Forecast",
  recommendation: "Recommendation",
  limitation: "Not available",
};

/** A NEØ module a signal was derived from. Used by the brain visual. */
export type NeoModule =
  | "pms"
  | "crm"
  | "pos"
  | "kitchen"
  | "inventory"
  | "procurement"
  | "finance"
  | "housekeeping"
  | "events"
  | "workforce"
  | "delivery";

export const MODULE_LABEL: Record<NeoModule, string> = {
  pms: "Rooms / PMS",
  crm: "Guests / CRM",
  pos: "Point of sale",
  kitchen: "Kitchen",
  inventory: "Inventory",
  procurement: "Procurement",
  finance: "Finance",
  housekeeping: "Housekeeping",
  events: "Events",
  workforce: "Workforce",
  delivery: "Delivery",
};

/** Business evidence: what records, how many, and where to see them. */
export type Evidence = {
  label: string;
  /** Number of underlying operational records, when countable. */
  recordCount?: number | null;
  /** Human description of the source, e.g. "finance_posting_receipts". */
  source: string;
  module: NeoModule;
  /** Route into the module where those records can be reviewed. */
  drillTo?: string;
};

export type Statement = {
  kind: StatementKind;
  text: string;
};

export type Confidence = "high" | "moderate" | "insufficient";

export type Severity = "critical" | "warning" | "info";

export type Scope = {
  propertyLabel: string;
  from: string;
  to: string;
  /** ISO timestamp the underlying payload was computed. */
  freshness?: string | undefined;
};

/** A ranked, proactive detection over scoped operational records. */
export type Discovery = {
  id: string;
  title: string;
  conclusion: string;
  severity: Severity;
  /** 0-100 ranking score: severity × materiality × recency × actionability. */
  score: number;
  /** Countable size of the finding (records, rooms, orders…). */
  magnitude: number;
  /** Money impact only when it is safely computable from records. */
  impact: { value: number; currency: string } | null;
  impactNote: string;
  modules: NeoModule[];
  evidence: Evidence[];
  actionable: boolean;
  drillTo?: string;
  /** Investigation topic key this discovery opens. */
  investigate?: string;
  /** How firmly the records support the conclusion. */
  confidence?: Confidence;
  /** Plain-language reason for that confidence — never a model score. */
  confidenceNote?: string;
  /** True when the finding came from a statistical outlier test. */
  outlier?: boolean;
};


/** A material change between the current window and the comparable prior one. */
export type ChangeItem = {
  id: string;
  label: string;
  current: number | null;
  previous: number | null;
  delta: number | null;
  deltaPercent: number | null;
  direction: "up" | "down" | "flat";
  /** True when the change is worth a human's attention. */
  material: boolean;
  favourable: "good" | "bad" | "neutral";
  unit: "count" | "money" | "percent";
  modules: NeoModule[];
  evidence: Evidence[];
};

/**
 * Structured visualisation description that the renderer turns into a chart.
 *
 * The representation is chosen by the engine to suit the decision — trends as
 * lines, comparisons as bars, explanations of a movement as a waterfall, and
 * demand/booking patterns as a heatmap — never a default chart type.
 */
export type Visualization =
  | { kind: "metric"; title: string; value: string; hint?: string }
  | {
      kind: "line" | "bar" | "area";
      title: string;
      xKey: string;
      series: { key: string; label: string }[];
      data: Record<string, string | number | null>[];
      unit?: "count" | "money" | "percent";
    }
  | {
      kind: "table";
      title: string;
      columns: { key: string; label: string }[];
      rows: Record<string, string | number | null>[];
    }
  /** Explains how a result moved: start, signed contributions, end. */
  | {
      kind: "waterfall";
      title: string;
      steps: { label: string; value: number; kind?: "start" | "delta" | "total" }[];
      unit?: "count" | "money" | "percent";
      note?: string;
    }
  /** Pattern over two dimensions, e.g. occupancy by weekday and week. */
  | {
      kind: "heatmap";
      title: string;
      xLabels: string[];
      yLabels: string[];
      /** rows[y][x]; null where nothing was recorded — never zero-filled. */
      rows: (number | null)[][];
      unit?: "count" | "money" | "percent";
      note?: string;
    };

/** A named contributor to a result, shown as "main drivers" under an answer. */
export type Driver = {
  label: string;
  value: string;
  direction: "up" | "down" | "flat";
  favourable?: "good" | "bad" | "neutral";
};

/** A decision object: never an action, always a prepared recommendation. */
export type Decision = {
  id: string;
  headline: string;
  kind: "recommendation" | "observation";
  why: string;
  evidence: Evidence[];
  confidence: Confidence;
  confidenceNote: string;
  impact: string;
  alternatives: string[];
  action: { label: string; to: string; requiresAuthorisation: true } | null;
  scenario?: {
    label: string;
    inputs: { label: string; value: string }[];
    outputs: { label: string; value: string }[];
    method: string;
  };
};

/** A grounded answer to a question asked of NEØ. */
export type GroundedAnswer = {
  topic: string;
  question: string;
  headline: string;
  statements: Statement[];
  evidence: Evidence[];
  modules: NeoModule[];
  visualization: Visualization | null;
  confidence: Confidence;
  scope: Scope;
  /** Present when NEØ cannot answer from records. */
  limitation: string | null;
  /** Named contributors behind the headline, when the records name them. */
  drivers?: Driver[];
  /** Contextual next questions this answer makes sensible. */
  followUps?: string[];
};

export type ConversationTurn = {
  id: string;
  question: string;
  answer: GroundedAnswer | null;
  narrative: string | null;
  narrativeStatus: string | null;
  pending: boolean;
  error: string | null;
};

/** A focused investigation of one issue, broken into contributing groups. */
export type Investigation = {
  topic: string;
  title: string;
  summary: string;
  scope: Scope;
  groups: { label: string; value: number | null; note: string; drillTo?: string }[];
  drivers: Statement[];
  evidence: Evidence[];
  modules: NeoModule[];
  actions: { label: string; to: string }[];
};
