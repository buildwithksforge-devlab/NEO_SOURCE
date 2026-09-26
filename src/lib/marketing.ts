/**
 * Phase 15 — Marketing, CRM automation & customer engagement vocabulary.
 *
 * Pure, dependency-free domain helpers: stage/status vocabularies, label maps,
 * consent + suppression semantics, template variable whitelist, attribution and
 * ROMI arithmetic. No data access happens here — see `marketing-data.ts`.
 */

/* ------------------------------------------------------------------ *
 * Leads
 * ------------------------------------------------------------------ */

export const LEAD_STAGES = [
  "new",
  "assigned",
  "contacted",
  "qualified",
  "needs_analysis",
  "quotation",
  "negotiation",
  "awaiting_customer",
  "won",
  "lost",
  "unqualified",
  "nurture",
  "archived",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

/** Stages shown as columns on the Kanban pipeline (terminal states are filtered lists). */
export const PIPELINE_STAGES: LeadStage[] = [
  "new",
  "assigned",
  "contacted",
  "qualified",
  "needs_analysis",
  "quotation",
  "negotiation",
  "awaiting_customer",
  "won",
  "lost",
];

export const leadStageLabels: Record<LeadStage, string> = {
  new: "New",
  assigned: "Assigned",
  contacted: "Contacted",
  qualified: "Qualified",
  needs_analysis: "Needs analysis",
  quotation: "Quotation",
  negotiation: "Negotiation",
  awaiting_customer: "Awaiting customer",
  won: "Won",
  lost: "Lost",
  unqualified: "Unqualified",
  nurture: "Nurture",
  archived: "Archived",
};

export const LEAD_TYPES = [
  "accommodation",
  "event",
  "conference",
  "restaurant",
  "delivery",
  "corporate",
  "general",
] as const;

export const LEAD_SOURCE_CATEGORIES = [
  "website",
  "telephone",
  "whatsapp",
  "email",
  "walk_in",
  "social",
  "referral",
  "campaign",
  "returning_customer",
  "other",
] as const;

export const LEAD_ACTIVITY_TYPES = [
  "call",
  "email",
  "whatsapp",
  "sms",
  "meeting",
  "site_visit",
  "quotation_reminder",
  "payment_reminder",
  "note",
  "task",
] as const;

export function leadStageTone(stage: string): "default" | "success" | "warning" | "info" | "destructive" {
  if (stage === "won") return "success";
  if (stage === "lost" || stage === "unqualified") return "destructive";
  if (stage === "negotiation" || stage === "quotation") return "warning";
  if (stage === "new" || stage === "assigned") return "info";
  return "default";
}

/** A follow-up is overdue when its due moment has passed and the lead is still open. */
export function isOverdue(nextFollowupAt: string | null | undefined, stage: string): boolean {
  if (!nextFollowupAt) return false;
  if (["won", "lost", "archived", "unqualified"].includes(stage)) return false;
  return new Date(nextFollowupAt).getTime() < Date.now();
}

/* ------------------------------------------------------------------ *
 * Consent & suppression
 * ------------------------------------------------------------------ */

export const CONSENT_CHANNELS = ["email", "sms", "whatsapp", "push", "in_app"] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const CONSENT_PURPOSES = [
  "service",
  "marketing",
  "profiling",
  "personalised_offers",
  "review_requests",
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

export const CONSENT_STATUSES = [
  "unknown",
  "pending",
  "granted",
  "withdrawn",
  "objected",
  "not_required",
  "expired",
] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const consentStatusLabels: Record<ConsentStatus, string> = {
  unknown: "Unknown",
  pending: "Pending",
  granted: "Granted",
  withdrawn: "Withdrawn",
  objected: "Objected",
  not_required: "Not required (service)",
  expired: "Expired",
};

export function consentTone(status: string): "default" | "success" | "warning" | "info" | "destructive" {
  if (status === "granted") return "success";
  if (status === "withdrawn" || status === "objected") return "destructive";
  if (status === "expired" || status === "pending") return "warning";
  if (status === "not_required") return "info";
  return "default";
}

export const SUPPRESSION_REASONS = [
  "unsubscribed",
  "do_not_contact",
  "email_bounce",
  "invalid_phone",
  "whatsapp_opt_out",
  "sms_opt_out",
  "complaint",
  "deceased",
  "legal_restriction",
  "internal_test",
  "duplicate_record",
  "temporary",
] as const;

export const suppressionReasonLabels: Record<string, string> = {
  unsubscribed: "Unsubscribed",
  do_not_contact: "Do not contact",
  email_bounce: "Email bounce",
  invalid_phone: "Invalid phone",
  whatsapp_opt_out: "WhatsApp opt-out",
  sms_opt_out: "SMS opt-out",
  complaint: "Complaint",
  deceased: "Deceased (lawfully recorded)",
  legal_restriction: "Legal restriction",
  internal_test: "Internal test account",
  duplicate_record: "Duplicate record",
  temporary: "Temporary suppression",
};

/**
 * Client-side mirror of the database `mkt_can_send` guard. The database is the
 * authority; this only powers previews and audience estimates in the browser.
 */
export function evaluateEligibility(input: {
  marketing: boolean;
  consentStatus: string | null | undefined;
  suppressionReason: string | null | undefined;
}): { allowed: boolean; reason: string } {
  if (input.suppressionReason) {
    return { allowed: false, reason: `Suppressed — ${suppressionReasonLabels[input.suppressionReason] ?? input.suppressionReason}` };
  }
  if (!input.marketing) return { allowed: true, reason: "Service message" };
  if (input.consentStatus !== "granted") {
    return { allowed: false, reason: `No marketing consent (${input.consentStatus ?? "unknown"})` };
  }
  return { allowed: true, reason: "Consented" };
}

/** Quiet hours may wrap past midnight (e.g. 21:00 → 07:00). */
export function isWithinQuietHours(at: Date, start: string, end: string): boolean {
  const mins = at.getHours() * 60 + at.getMinutes();
  const toMin = (v: string) => {
    const [h = "0", m = "0"] = v.split(":");
    return Number(h) * 60 + Number(m);
  };
  const s = toMin(start);
  const e = toMin(end);
  return s <= e ? mins >= s && mins < e : mins >= s || mins < e;
}

/* ------------------------------------------------------------------ *
 * Campaigns
 * ------------------------------------------------------------------ */

export const CAMPAIGN_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "running",
  "paused",
  "completed",
  "cancelled",
  "failed",
  "archived",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const campaignStatusLabels: Record<CampaignStatus, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  approved: "Approved",
  scheduled: "Scheduled",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
  archived: "Archived",
};

export function campaignTone(status: string): "default" | "success" | "warning" | "info" | "destructive" {
  if (status === "running" || status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "destructive";
  if (status === "pending_approval" || status === "paused") return "warning";
  if (status === "scheduled" || status === "approved") return "info";
  return "default";
}

export const CAMPAIGN_TYPES = [
  "email",
  "whatsapp",
  "sms",
  "in_system",
  "push",
  "promotional_offer",
  "seasonal",
  "holiday",
  "corporate",
  "weekend_package",
  "conference",
  "restaurant",
  "delivery",
  "loyalty",
  "win_back",
  "review",
  "multi_channel",
] as const;

export const CAMPAIGN_OBJECTIVES = [
  "Fill low-occupancy dates",
  "Increase repeat stays",
  "Grow restaurant covers",
  "Grow delivery orders",
  "Win back inactive guests",
  "Promote a conference package",
  "Collect reviews",
  "Grow loyalty membership",
] as const;

export const DELIVERY_STATUSES = [
  "excluded",
  "pending",
  "queued",
  "sent",
  "delivered",
  "read",
  "opened",
  "clicked",
  "failed",
  "bounced",
  "unsubscribed",
  "complained",
  "converted",
] as const;

/** Statuses a given channel's provider can genuinely report — never fabricate the rest. */
export const supportedStatusesByChannel: Record<string, string[]> = {
  email: ["queued", "sent", "delivered", "opened", "clicked", "failed", "bounced", "unsubscribed", "complained"],
  sms: ["queued", "sent", "delivered", "failed", "unsubscribed"],
  whatsapp: ["queued", "sent", "delivered", "read", "failed", "unsubscribed"],
  in_app: ["queued", "sent", "read"],
  push: ["queued", "sent", "delivered", "failed"],
};

/* ------------------------------------------------------------------ *
 * Templates & personalization
 * ------------------------------------------------------------------ */

/** Only these variables may appear in a marketing template — nothing sensitive. */
export const TEMPLATE_VARIABLES = [
  { token: "{{preferred_name}}", label: "Customer preferred name", fallback: "there" },
  { token: "{{organization_name}}", label: "Organization name", fallback: "our hotel" },
  { token: "{{branch_name}}", label: "Branch name", fallback: "our property" },
  { token: "{{loyalty_tier}}", label: "Loyalty tier", fallback: "Member" },
  { token: "{{points_balance}}", label: "Points balance", fallback: "0" },
  { token: "{{voucher_code}}", label: "Voucher code", fallback: "" },
  { token: "{{offer_expiry}}", label: "Offer expiry", fallback: "soon" },
  { token: "{{booking_reference}}", label: "Booking reference (service messages only)", fallback: "" },
] as const;

const VARIABLE_PATTERN = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Returns variables used in a body that are not on the approved whitelist. */
export function invalidVariables(body: string): string[] {
  const allowed = new Set(TEMPLATE_VARIABLES.map((v) => v.token.replace(/[{}\s]/g, "")));
  const found = new Set<string>();
  for (const match of body.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (name && !allowed.has(name)) found.add(name);
  }
  return [...found];
}

/** Renders a preview with fallback text so missing data never leaves a blank gap. */
export function renderPreview(body: string, values: Record<string, string | null | undefined>): string {
  return body.replace(VARIABLE_PATTERN, (_full, name: string) => {
    const value = values[name];
    if (value) return value;
    const def = TEMPLATE_VARIABLES.find((v) => v.token.includes(name));
    return def?.fallback ?? "";
  });
}

/* ------------------------------------------------------------------ *
 * Attribution, spend and returns
 * ------------------------------------------------------------------ */

export const ATTRIBUTION_MODELS = [
  { value: "first_touch", label: "First touch" },
  { value: "last_touch", label: "Last touch" },
  { value: "linear", label: "Linear (preparation)" },
  { value: "campaign_code", label: "Campaign code" },
  { value: "voucher", label: "Voucher redemption" },
] as const;

export const COST_TYPES = [
  "messaging",
  "advertising",
  "discount",
  "voucher",
  "complimentary",
  "creative",
  "agency",
  "activation",
  "other",
] as const;

export type RoiResult = {
  /** null when cost is zero — never divide by zero, never invent a ratio. */
  ratio: number | null;
  /** True ROMI needs gross profit; otherwise the figure is revenue-based. */
  basis: "gross_profit" | "revenue" | "unavailable";
  label: string;
};

/**
 * ROMI = (attributed gross profit − marketing cost) ÷ marketing cost.
 * Where gross profit is unavailable the result is labelled revenue-based return.
 */
export function calculateRomi(input: {
  cost: number;
  revenue: number;
  grossProfit?: number | null;
}): RoiResult {
  const basis: RoiResult["basis"] =
    input.grossProfit != null ? "gross_profit" : input.revenue > 0 ? "revenue" : "unavailable";
  if (!input.cost || input.cost <= 0) {
    return {
      ratio: null,
      basis,
      label: "No recorded marketing cost — return cannot be calculated",
    };
  }
  const numerator = (input.grossProfit ?? input.revenue) - input.cost;
  return {
    ratio: numerator / input.cost,
    basis,
    label: basis === "gross_profit" ? "ROMI (gross profit based)" : "Revenue-based return (not true ROMI)",
  };
}

export const CONVERSION_TYPES = [
  "lead_created",
  "reservation_confirmed",
  "event_confirmed",
  "restaurant_order",
  "delivery_completed",
  "loyalty_enrollment",
  "voucher_redeemed",
  "corporate_account",
  "payment_completed",
] as const;

/* ------------------------------------------------------------------ *
 * Journeys (automated customer journeys)
 * ------------------------------------------------------------------ */

export const JOURNEY_TRIGGERS = [
  "customer_created",
  "first_booking",
  "booking_confirmed",
  "check_in",
  "check_out",
  "restaurant_visit_completed",
  "delivery_completed",
  "event_completed",
  "birthday_approaching",
  "anniversary_approaching",
  "loyalty_tier_reached",
  "points_expiring",
  "voucher_expiring",
  "feedback_submitted",
  "complaint_resolved",
  "customer_inactive",
  "lead_created",
  "lead_inactive",
  "corporate_invoice_paid",
] as const;

export const JOURNEY_STEP_TYPES = [
  "wait",
  "condition",
  "send_message",
  "add_segment",
  "remove_segment",
  "create_voucher",
  "award_points",
  "create_task",
  "notify_staff",
  "request_review",
  "update_tag",
  "branch",
  "stop",
] as const;

export const journeyStepLabels: Record<string, string> = {
  wait: "Wait",
  condition: "Check condition",
  send_message: "Send message",
  add_segment: "Add to segment",
  remove_segment: "Remove from segment",
  create_voucher: "Create voucher",
  award_points: "Award approved points",
  create_task: "Create staff task",
  notify_staff: "Notify staff",
  request_review: "Request review",
  update_tag: "Update customer tag",
  branch: "Branch into paths",
  stop: "Stop journey",
};

/** Deterministic idempotency key so one trigger can never enroll a guest twice. */
export function journeyIdempotencyKey(journeyId: string, customerId: string, period: string): string {
  return `${journeyId}:${customerId}:${period}`;
}

/** Birthday/anniversary journeys are capped to one entry per calendar year. */
export function annualPeriod(date: Date = new Date()): string {
  return String(date.getUTCFullYear());
}

/* ------------------------------------------------------------------ *
 * Reputation & service recovery
 * ------------------------------------------------------------------ */

export const REVIEW_SOURCES = [
  "internal",
  "website",
  "restaurant",
  "delivery",
  "event",
  "stay",
  "google",
  "booking_com",
  "tripadvisor",
  "other",
] as const;

/** Sources that require a live provider integration before anything can be imported. */
export const EXTERNAL_REVIEW_SOURCES = ["google", "booking_com", "tripadvisor"] as const;

export const REVIEW_STATUSES = [
  "new",
  "assigned",
  "investigating",
  "response_drafted",
  "pending_approval",
  "responded",
  "escalated",
  "resolved",
  "closed",
] as const;

export const RECOVERY_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const COMPENSATION_TYPES = [
  "none",
  "apology",
  "voucher",
  "points",
  "discount",
  "complimentary",
  "refund",
] as const;

/** Compensation with a monetary value must route through the Approval Centre. */
export function compensationNeedsApproval(type: string, value: number): boolean {
  if (type === "none" || type === "apology") return false;
  return value > 0;
}

/* ------------------------------------------------------------------ *
 * Segment builder vocabulary
 * ------------------------------------------------------------------ */

export type SegmentOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between" | "in" | "is_set";

export type SegmentCondition = {
  id: string;
  attribute: string;
  operator: SegmentOperator;
  value: string;
  value2?: string;
};

export type SegmentRuleSet = {
  match: "all" | "any";
  conditions: SegmentCondition[];
  exclusions: SegmentCondition[];
};

export const SEGMENT_ATTRIBUTES = [
  { value: "branch", label: "Branch", kind: "text" },
  { value: "customer_type", label: "Customer type", kind: "text" },
  { value: "stay_count", label: "Stay count", kind: "number" },
  { value: "order_count", label: "Order count", kind: "number" },
  { value: "last_visit_days", label: "Days since last visit", kind: "number" },
  { value: "last_order_days", label: "Days since last order", kind: "number" },
  { value: "total_spend", label: "Total spend", kind: "number" },
  { value: "average_spend", label: "Average spend", kind: "number" },
  { value: "room_preference", label: "Room preference", kind: "text" },
  { value: "meal_preference", label: "Meal preference", kind: "text" },
  { value: "event_type", label: "Event type", kind: "text" },
  { value: "delivery_zone", label: "Delivery zone", kind: "text" },
  { value: "loyalty_tier", label: "Loyalty tier", kind: "text" },
  { value: "points_balance", label: "Points balance", kind: "number" },
  { value: "campaign_response", label: "Campaign response", kind: "text" },
  { value: "review_rating", label: "Review rating", kind: "number" },
  { value: "feedback_category", label: "Feedback category", kind: "text" },
  { value: "birthday_month", label: "Birthday month", kind: "number" },
  { value: "anniversary_month", label: "Anniversary month", kind: "number" },
  { value: "inactivity_days", label: "Inactivity period (days)", kind: "number" },
  { value: "consent_status", label: "Consent status", kind: "text" },
  { value: "customer_tag", label: "Customer tag", kind: "text" },
] as const;

/** Attributes that may never be used to target people. */
export const PROHIBITED_SEGMENT_ATTRIBUTES = [
  "national_id",
  "passport",
  "medical",
  "religion",
  "ethnicity",
  "payment_card",
  "exact_location",
];

export const operatorLabels: Record<SegmentOperator, string> = {
  eq: "is",
  neq: "is not",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  between: "between",
  in: "is one of",
  is_set: "is recorded",
};

export const SEGMENT_TEMPLATES: { name: string; description: string; rules: SegmentRuleSet }[] = [
  {
    name: "New customers",
    description: "Created in the last 30 days.",
    rules: { match: "all", conditions: [{ id: "1", attribute: "last_visit_days", operator: "lte", value: "30" }], exclusions: [] },
  },
  {
    name: "Returning guests",
    description: "Two or more completed stays.",
    rules: { match: "all", conditions: [{ id: "1", attribute: "stay_count", operator: "gte", value: "2" }], exclusions: [] },
  },
  {
    name: "Inactive customers",
    description: "No activity for six months or more.",
    rules: { match: "all", conditions: [{ id: "1", attribute: "inactivity_days", operator: "gte", value: "180" }], exclusions: [] },
  },
  {
    name: "Loyalty members",
    description: "Enrolled in the loyalty programme.",
    rules: { match: "all", conditions: [{ id: "1", attribute: "loyalty_tier", operator: "is_set", value: "" }], exclusions: [] },
  },
  {
    name: "Birthday this month",
    description: "Birthday falls in the current calendar month.",
    rules: { match: "all", conditions: [{ id: "1", attribute: "birthday_month", operator: "eq", value: String(new Date().getMonth() + 1) }], exclusions: [] },
  },
  {
    name: "High spenders",
    description: "Lifetime spend above the configured threshold.",
    rules: { match: "all", conditions: [{ id: "1", attribute: "total_spend", operator: "gte", value: "100000" }], exclusions: [] },
  },
];

/* ------------------------------------------------------------------ *
 * Customer lifetime value
 * ------------------------------------------------------------------ */

export const CLV_METHODS = [
  { value: "historical", label: "Historical customer value (recorded revenue only)" },
  { value: "frequency_value", label: "Predicted — average value × frequency × retention" },
  { value: "margin_based", label: "Predicted — gross margin based" },
] as const;

/**
 * Transparent CLV. Predicted figures are estimates and must always be presented
 * with their method, period and limitation alongside them.
 */
export function calculateClv(input: {
  method: string;
  historicalRevenue: number;
  refunds?: number;
  discounts?: number;
  averageTransaction?: number;
  visitsPerYear?: number;
  retentionYears?: number;
  grossMarginRate?: number | null;
  acquisitionCost?: number;
}): { historical: number; predicted: number | null; confidence: "low" | "medium" | "high"; note: string } {
  const historical = Math.max(0, input.historicalRevenue - (input.refunds ?? 0) - (input.discounts ?? 0));
  if (input.method === "historical") {
    return { historical, predicted: null, confidence: "high", note: "Recorded revenue only — no prediction made." };
  }
  const avg = input.averageTransaction ?? 0;
  const freq = input.visitsPerYear ?? 0;
  const years = input.retentionYears ?? 0;
  if (avg <= 0 || freq <= 0 || years <= 0) {
    return { historical, predicted: null, confidence: "low", note: "Not enough recorded activity to estimate." };
  }
  let predicted = avg * freq * years;
  if (input.method === "margin_based") {
    if (input.grossMarginRate == null) {
      return { historical, predicted: null, confidence: "low", note: "Gross margin is not recorded for this organization." };
    }
    predicted *= input.grossMarginRate;
  }
  predicted -= input.acquisitionCost ?? 0;
  const confidence = freq >= 3 && years >= 2 ? "medium" : "low";
  return {
    historical,
    predicted: Math.max(0, predicted),
    confidence,
    note: "Estimate only — not a guarantee of future value.",
  };
}

/* ------------------------------------------------------------------ *
 * Provider configuration status
 * ------------------------------------------------------------------ */

export type ProviderStatus = "not_configured" | "pending_verification" | "configured";

export const providerStatusLabels: Record<ProviderStatus, string> = {
  not_configured: "Not Configured",
  pending_verification: "Pending verification",
  configured: "Configured",
};

export function providerTone(status: string): "default" | "success" | "warning" | "destructive" {
  if (status === "configured") return "success";
  if (status === "pending_verification") return "warning";
  return "destructive";
}

export function notConfiguredMessage(channel: string): string {
  return `${channel} — Not Configured`;
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

export function titleCase(value: string | null | undefined): string {
  if (!value) return "—";
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function percent(part: number, total: number): string {
  if (!total) return "—";
  return `${((part / total) * 100).toFixed(1)}%`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
