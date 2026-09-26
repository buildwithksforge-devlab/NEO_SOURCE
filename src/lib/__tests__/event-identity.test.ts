import { describe, expect, it } from "vitest";
import {
  buildEventTimelines,
  eventCount,
  identityOf,
  type EventStageRecord,
} from "@/lib/event-identity";

const rec = (r: Partial<EventStageRecord> & Pick<EventStageRecord, "stage" | "id">): EventStageRecord => ({
  organizationId: "org",
  propertyId: "prop-a",
  ...r,
});

const chain: EventStageRecord[] = [
  rec({ stage: "enquiry", id: "enq-1", reference: "ENQ-1" }),
  rec({ stage: "quote", id: "q-1", enquiryId: "enq-1" }),
  rec({ stage: "booking", id: "bk-1", enquiryId: "enq-1", quotationId: "q-1", bookingId: "bk-1" }),
  rec({ stage: "deposit", id: "dep-1", bookingId: "bk-1", amount: 50_000 }),
  rec({ stage: "readiness", id: "rd-1", bookingId: "bk-1" }),
  rec({ stage: "invoice", id: "inv-1", bookingId: "bk-1", amount: 220_000 }),
  rec({ stage: "payment", id: "pay-1", bookingId: "bk-1", amount: 170_000 }),
];

describe("one identity per event", () => {
  it("resolves an enquiry-only event to the enquiry", () => {
    expect(identityOf(chain[0]!)).toMatchObject({ eventId: "enq-1", booked: false });
  });

  it("resolves every later stage to the booking", () => {
    for (const r of chain.slice(2)) expect(identityOf(r).eventId).toBe("bk-1");
  });

  it("refuses a stage record with no organisation, property or parent", () => {
    expect(() => identityOf(rec({ stage: "invoice", id: "x", organizationId: null }))).toThrow(/organisation/);
    expect(() => identityOf(rec({ stage: "invoice", id: "x", propertyId: null }))).toThrow(/property/);
    expect(() => identityOf(rec({ stage: "payment", id: "x" }))).toThrow(/cannot be traced/);
  });
});

describe("timelines", () => {
  it("folds the whole chain into one event with no missing stages", () => {
    const timelines = buildEventTimelines(chain);
    expect(timelines).toHaveLength(2); // the enquiry identity plus the booked event
    const booked = timelines.find((t) => t.identity.booked)!;
    expect(booked.identity.eventId).toBe("bk-1");
    expect(booked.furthestStage).toBe("payment");
    expect(booked.missingStages).toEqual(["enquiry", "quote"]);
  });

  it("quarantines a stage recorded against another property instead of merging it", () => {
    const timelines = buildEventTimelines([
      ...chain,
      rec({ stage: "payment", id: "pay-2", bookingId: "bk-1", propertyId: "prop-b", amount: 1 }),
    ]);
    const booked = timelines.find((t) => t.identity.booked)!;
    expect(booked.crossPropertyRecords.map((r) => r.id)).toEqual(["pay-2"]);
    expect(booked.stages.payment.map((r) => r.id)).toEqual(["pay-1"]);
  });

  it("gives the workspace and the manager dashboard the same count", () => {
    const timelines = buildEventTimelines(chain);
    expect(eventCount(timelines, { propertyId: "prop-a", bookedOnly: true })).toBe(1);
    expect(eventCount(timelines, { propertyId: "prop-b", bookedOnly: true })).toBe(0);
  });
});
