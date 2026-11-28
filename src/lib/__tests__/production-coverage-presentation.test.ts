import { describe, expect, it } from "vitest";

import {
  coverageTasks,
  productionCoverageProgress,
} from "../production-coverage-presentation";

function task(
  station: string,
  status: string,
  extra: Record<string, unknown> = {},
) {
  return {
    station_id: station,
    status,
    remake_of_id: null,
    ...extra,
  };
}

function item(
  tasks: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) {
  return {
    commercial_status: "sent",
    required_station_ids: ["kitchen", "bar"],
    production_tasks: tasks,
    cancellation_pending: false,
    ...extra,
  };
}

describe("authoritative production coverage", () => {

  it("reads the actual RPC production_tasks field", () => {
    expect(
      coverageTasks(item([task("kitchen", "ready")]))
    ).toHaveLength(1);
  });

  it("does not confirm readiness when a station is missing", () => {
    expect(
      productionCoverageProgress(
        item([task("kitchen", "ready")])
      )
    ).toBe("coverage-unverified");
  });

  it("uses the slowest mandatory station", () => {
    expect(
      productionCoverageProgress(
        item([
          task("kitchen", "ready"),
          task("bar", "preparing"),
        ])
      )
    ).toBe("preparing");
  });

  it("confirms readiness when all required stations are ready", () => {
    expect(
      productionCoverageProgress(
        item([
          task("kitchen", "ready"),
          task("bar", "ready"),
        ])
      )
    ).toBe("ready");
  });

  it("does not infer missing routing requirements", () => {
    expect(
      productionCoverageProgress(
        item(
          [task("kitchen", "ready")],
          { required_station_ids: [] },
        )
      )
    ).toBe("coverage-unverified");
  });

  it("rejects duplicate station task coverage", () => {
    expect(
      productionCoverageProgress(
        item([
          task("kitchen", "ready"),
          task("kitchen", "ready"),
          task("bar", "ready"),
        ])
      )
    ).toBe("review-required");
  });

  it("does not assume remake completion", () => {
    expect(
      productionCoverageProgress(
        item([
          task("kitchen", "ready"),
          task("bar", "ready", { remake_of_id: "original" }),
        ])
      )
    ).toBe("review-required");
  });

  it("gives cancellation requests priority over readiness", () => {
    expect(
      productionCoverageProgress(
        item(
          [
            task("kitchen", "ready"),
            task("bar", "ready"),
          ],
          { cancellation_pending: true },
        )
      )
    ).toBe("cancellation-pending");
  });

  it("preserves undispatched draft status", () => {
    expect(
      productionCoverageProgress(
        item([], { commercial_status: "draft" })
      )
    ).toBe("draft");
  });

  it("preserves approved cancellation status", () => {
    expect(
      productionCoverageProgress(
        item([], { commercial_status: "voided" })
      )
    ).toBe("cancelled");
  });

  it("does not treat a cancelled station as ready", () => {
    expect(
      productionCoverageProgress(
        item([
          task("kitchen", "ready"),
          task("bar", "cancelled"),
        ])
      )
    ).toBe("review-required");
  });

  it("rejects unexpected station relationships", () => {
    expect(
      productionCoverageProgress(
        item([
          task("kitchen", "ready"),
          task("bar", "ready"),
          task("pastry", "ready"),
        ])
      )
    ).toBe("review-required");
  });

  it("does not mark a partially served item fully served", () => {
    expect(
      productionCoverageProgress(
        item([
          task("kitchen", "served"),
          task("bar", "ready"),
        ])
      )
    ).toBe("ready");
  });

  it("confirms service only when all stations have completed it", () => {
    expect(
      productionCoverageProgress(
        item([
          task("kitchen", "completed"),
          task("bar", "served"),
        ])
      )
    ).toBe("served");
  });
});