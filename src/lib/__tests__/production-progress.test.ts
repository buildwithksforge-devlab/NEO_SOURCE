import { describe, expect, it } from "vitest";
import {
  calculateProductionProgress,
} from "@/lib/production-progress";

const requiredStationIds = ["kitchen", "pastry"];

function progress(
  kitchen: string,
  pastry: string,
  commercialStatus = "sent",
  cancellationPending = false,
) {
  return calculateProductionProgress({
    requiredStationIds,
    commercialStatus,
    cancellationPending,
    tasks: [
      { stationId: "kitchen", status: kitchen },
      { stationId: "pastry", status: pastry },
    ],
  });
}

describe("cross-station production progress", () => {
  it("recognizes receipt by both production stations", () => {
    expect(progress("new", "new").status).toBe("received");
  });

  it("does not report acceptance before both stations accept", () => {
    expect(progress("accepted", "new").status).toBe("received");
  });

  it("does not report readiness while another station is preparing", () => {
    const result = progress("ready", "preparing");
    expect(result.status).toBe("preparing");
    expect(result.readyStations).toBe(1);
  });

  it("reports ready only when both required stations are ready", () => {
    expect(progress("ready", "ready").status).toBe("ready");
  });

  it("does not report complete service from one station", () => {
    expect(progress("served", "ready").status).toBe("ready");
  });

  it("reports served when every required station completes service", () => {
    expect(progress("completed", "served").status).toBe("served");
  });

  it("prioritizes pending cancellation", () => {
    expect(
      progress("ready", "ready", "sent", true).status,
    ).toBe("cancellation-pending");
  });

  it("preserves approved commercial cancellation", () => {
    expect(progress("ready", "served", "voided").status).toBe("cancelled");
  });

  it("recognizes missing secondary routing", () => {
    const result = calculateProductionProgress({
      requiredStationIds,
      commercialStatus: "sent",
      tasks: [{ stationId: "kitchen", status: "ready" }],
    });

    expect(result.status).toBe("review-required");
    expect(result.missingStationIds).toEqual(["pastry"]);
  });

  it("does not treat a cancelled required task as completed", () => {
    expect(progress("ready", "cancelled").status).toBe("review-required");
  });

  it("detects conflicting active production tasks", () => {
    const result = calculateProductionProgress({
      requiredStationIds,
      commercialStatus: "sent",
      tasks: [
        { stationId: "kitchen", status: "ready" },
        { stationId: "kitchen", status: "preparing" },
        { stationId: "pastry", status: "ready" },
      ],
    });

    expect(result.status).toBe("review-required");
    expect(result.conflictingStationIds).toEqual(["kitchen"]);
  });

  it("does not report an unrouted item as ready", () => {
    expect(
      calculateProductionProgress({
        requiredStationIds: [],
        commercialStatus: "draft",
        tasks: [],
      }).status,
    ).toBe("unrouted");
  });

  it("deduplicates repeated required station identities", () => {
    expect(
      calculateProductionProgress({
        requiredStationIds: ["bar", "bar"],
        commercialStatus: "sent",
        tasks: [{ stationId: "bar", status: "ready" }],
      }).requiredStations,
    ).toBe(1);
  });

  it("returns an item undergoing a remake to preparation", () => {
    expect(progress("ready", "remaking").status).toBe("preparing");
  });
});