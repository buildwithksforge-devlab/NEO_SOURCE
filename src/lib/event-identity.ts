/**
 * One identity for an event, from enquiry to final payment.
 *
 * The Events workspace and the manager dashboard disagreed because each stage
 * carried its own primary key: the quote knew its enquiry, the booking knew its
 * quote, the deposit knew a folio, readiness knew a booking, and nothing tied
 * the invoice back to the enquiry that started it. Counting "events this month"
 * therefore gave a different answer per screen.
 *
 * The canonical event identity is `(organizationId, propertyId, eventId)` where
 * `eventId` is the booking id once a booking exists and the enquiry id before
 * that. Every stage record maps onto it here, so all surfaces group the same
 * way and a stage can never be attributed to another property.
 */

export type EventStage =
  | "enquiry"
  | "quote"
  | "booking"
  | "deposit"
  | "readiness"
  | "invoice"
  | "payment";

export const EVENT_STAGES: readonly EventStage[] = [
  "enquiry",
  "quote",
  "booking",
  "deposit",
  "readiness",
  "invoice",
  "payment",
];

export type EventStageRecord = {
  stage: EventStage;
  /** Primary key of the stage record itself. */
  id: string;
  organizationId: string | null;
  propertyId: string | null;
  enquiryId?: string | null;
  quotationId?: string | null;
  bookingId?: string | null;
  reference?: string | null;
  amount?: number | null;
  occurredAt?: string | null;
};

export type EventIdentity = {
  organizationId: string;
  propertyId: string;
  /** Booking id when booked, otherwise the enquiry id. */
  eventId: string;
  /** True once a booking exists — before that the event is still a prospect. */
  booked: boolean;
};

export class EventIdentityError extends Error {}

/** Resolve the canonical identity a stage record belongs to. */
export function identityOf(record: EventStageRecord): EventIdentity {
  if (!record.organizationId) throw new EventIdentityError(`${record.stage} ${record.id} has no organisation`);
  if (!record.propertyId) throw new EventIdentityError(`${record.stage} ${record.id} has no property`);
  const eventId = record.bookingId ?? record.enquiryId ?? (record.stage === "enquiry" ? record.id : null);
  if (!eventId)
    throw new EventIdentityError(
      `${record.stage} ${record.id} cannot be traced to an event — it references neither a booking nor an enquiry`,
    );
  return {
    organizationId: record.organizationId,
    propertyId: record.propertyId,
    eventId,
    booked: Boolean(record.bookingId),
  };
}

export const identityKey = (i: EventIdentity) => `${i.organizationId}:${i.propertyId}:${i.eventId}`;

export type EventTimeline = {
  identity: EventIdentity;
  stages: Record<EventStage, EventStageRecord[]>;
  /** Furthest stage reached, in canonical order. */
  furthestStage: EventStage;
  /** Stages that have not happened yet. */
  missingStages: EventStage[];
  /** Records that name this event but sit on another property. */
  crossPropertyRecords: EventStageRecord[];
};

const emptyStages = (): Record<EventStage, EventStageRecord[]> =>
  EVENT_STAGES.reduce((acc, s) => {
    acc[s] = [];
    return acc;
  }, {} as Record<EventStage, EventStageRecord[]>);

/**
 * Group stage records into one timeline per event. Records that resolve to the
 * same event id but a different property are quarantined rather than folded in
 * — that combination is a data defect, never a legitimate multi-property event.
 */
export function buildEventTimelines(records: EventStageRecord[]): EventTimeline[] {
  const byEvent = new Map<string, EventTimeline>();
  const homeProperty = new Map<string, string>();

  // Bookings and enquiries define the home property before anything else can.
  for (const r of records) {
    if (r.stage !== "booking" && r.stage !== "enquiry") continue;
    try {
      const id = identityOf(r);
      const key = `${id.organizationId}:${id.eventId}`;
      if (r.stage === "booking" || !homeProperty.has(key)) homeProperty.set(key, id.propertyId);
    } catch {
      /* unresolvable records are reported by identityOf at the call site */
    }
  }

  for (const r of records) {
    let id: EventIdentity;
    try {
      id = identityOf(r);
    } catch {
      continue;
    }
    const eventKey = `${id.organizationId}:${id.eventId}`;
    const home = homeProperty.get(eventKey) ?? id.propertyId;
    const canonical: EventIdentity = { ...id, propertyId: home };
    const key = identityKey(canonical);
    let timeline = byEvent.get(key);
    if (!timeline) {
      timeline = {
        identity: canonical,
        stages: emptyStages(),
        furthestStage: "enquiry",
        missingStages: [],
        crossPropertyRecords: [],
      };
      byEvent.set(key, timeline);
    }
    if (id.propertyId !== home) {
      timeline.crossPropertyRecords.push(r);
      continue;
    }
    timeline.stages[r.stage].push(r);
    timeline.identity.booked ||= canonical.booked;
  }

  for (const timeline of byEvent.values()) {
    const reached = EVENT_STAGES.filter((s) => timeline.stages[s].length > 0);
    timeline.furthestStage = reached.length ? reached[reached.length - 1]! : "enquiry";
    timeline.missingStages = EVENT_STAGES.filter((s) => timeline.stages[s].length === 0);
  }

  return [...byEvent.values()];
}

/** The one number every events surface must agree on for a property + period. */
export function eventCount(timelines: EventTimeline[], opts: { propertyId: string; bookedOnly?: boolean }) {
  return timelines.filter(
    (t) => t.identity.propertyId === opts.propertyId && (!opts.bookedOnly || t.identity.booked),
  ).length;
}
