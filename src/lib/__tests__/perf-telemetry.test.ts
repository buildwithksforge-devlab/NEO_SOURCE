/**
 * The performance figures are only useful if they are honest: a p95 that is
 * really a mean, or a "critical" action classified as a lookup, would hide
 * exactly the slowness we are trying to find. These lock the maths and the
 * classification, and prove no guest detail rides along in a span.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  ACTION_TARGET_MS,
  actionSpansCsv,
  resetActionSpans,
  getActionSpans,
  percentile,
  recordActionSpan,
  summariseActions,
  RELEASE,
} from "@/lib/perf-telemetry";
import { rpcActionClass } from "@/lib/rpc-telemetry";
import { backoffDelayMs } from "@/lib/realtime-scope";

function span(action: string, durationMs: number, extra: Partial<Parameters<typeof recordActionSpan>[0]> = {}) {
  recordActionSpan({
    action,
    kind: "save",
    correlationId: "c1",
    propertyId: null,
    release: RELEASE,
    durationMs,
    outcome: "ok",
    retries: 0,
    at: Date.now(),
    ...extra,
  });
}

describe("percentile", () => {
  it("reports the value 95 of 100 samples fall within, not the average", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
  });

  it("surfaces a slow tail that an average would hide", () => {
    const values = [...Array.from({ length: 95 }, () => 100), ...Array.from({ length: 5 }, () => 9000)];
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    // The mean lands near 545 ms and looks acceptable; p99 shows the five
    // members of staff who actually waited nine seconds.
    expect(mean).toBeLessThan(1_000);
    expect(percentile(values, 99)).toBe(9_000);
  });

  it("returns zero rather than NaN with no samples", () => {
    expect(percentile([], 95)).toBe(0);
  });
});

describe("summariseActions", () => {
  beforeEach(() => resetActionSpans());

  it("flags an action whose p95 is over its target", () => {
    for (let i = 0; i < 20; i += 1) span("neo_slow_save", ACTION_TARGET_MS.save + 500);
    const [row] = summariseActions(getActionSpans());
    expect(row?.action).toBe("neo_slow_save");
    expect(row?.breaching).toBe(true);
    expect(row?.targetMs).toBe(ACTION_TARGET_MS.save);
  });

  it("counts a refusal separately from a failure", () => {
    span("neo_guarded", 120, { outcome: "rejected" });
    span("neo_guarded", 120, { outcome: "failed" });
    const [row] = summariseActions(getActionSpans());
    expect(row?.rejections).toBe(1);
    expect(row?.failures).toBe(1);
  });

  it("times the target against successful attempts only", () => {
    for (let i = 0; i < 10; i += 1) span("neo_ok", 100);
    span("neo_ok", 60_000, { outcome: "timeout" });
    const [row] = summariseActions(getActionSpans());
    expect(row?.breaching).toBe(false);
  });
});

describe("exported measurements", () => {
  beforeEach(() => resetActionSpans());

  it("carries no guest, PIN or payment detail", () => {
    span("neo_pos_settle_order", 400);
    const csv = actionSpansCsv(getActionSpans());
    expect(csv).toContain("neo_pos_settle_order");
    expect(csv.toLowerCase()).not.toMatch(/pin|phone|msisdn|card|secret|guest_name/);
  });
});

describe("rpcActionClass", () => {
  it("treats money and stock movement as critical", () => {
    expect(rpcActionClass("neo_pos_settle_order")).toBe("critical");
    expect(rpcActionClass("neo_grn_receive_lines")).toBe("critical");
    expect(rpcActionClass("neo_folio_checkout")).toBe("critical");
  });

  it("separates a save from a plain lookup", () => {
    expect(rpcActionClass("neo_task_create")).toBe("save");
    expect(rpcActionClass("neo_stock_live_board")).toBe("read");
  });
});

describe("reconnect backoff", () => {
  it("backs off exponentially and then stops growing", () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(2)).toBe(2_000);
    expect(backoffDelayMs(3)).toBe(4_000);
    expect(backoffDelayMs(20)).toBe(30_000);
  });

  it("never waits a negative or zero time on a first attempt", () => {
    expect(backoffDelayMs(0)).toBeGreaterThan(0);
  });
});
