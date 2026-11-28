export type ProductionProgressStatus =
  | "unrouted"
  | "received"
  | "accepted"
  | "preparing"
  | "ready"
  | "collected"
  | "served"
  | "cancellation-pending"
  | "cancelled"
  | "review-required";

export type ProductionTask = {
  stationId: string;
  status: string;
};

export type ProductionProgress = {
  status: ProductionProgressStatus;
  requiredStations: number;
  readyStations: number;
  servedStations: number;
  missingStationIds: string[];
  conflictingStationIds: string[];
};

const ranks: Record<string, number> = {
  new: 1,
  sent: 1,
  accepted: 2,
  preparing: 3,
  remaking: 3,
  ready: 4,
  collected: 5,
  served: 6,
  completed: 6,
};

export function calculateProductionProgress(input: {
  requiredStationIds: string[];
  tasks: ProductionTask[];
  commercialStatus: string;
  cancellationPending?: boolean;
}): ProductionProgress {
  const required = [...new Set(input.requiredStationIds)];

  const result: ProductionProgress = {
    status: "unrouted",
    requiredStations: required.length,
    readyStations: 0,
    servedStations: 0,
    missingStationIds: [],
    conflictingStationIds: [],
  };

  if (
    ["cancelled", "voided"].includes(input.commercialStatus)
  ) {
    return { ...result, status: "cancelled" };
  }

  if (input.cancellationPending) {
    return { ...result, status: "cancellation-pending" };
  }

  if (required.length === 0) {
    return result;
  }

  const stationRanks: number[] = [];

  for (const stationId of required) {
    const tasks = input.tasks.filter(
      (task) => task.stationId === stationId,
    );

    if (tasks.length === 0) {
      result.missingStationIds.push(stationId);
      continue;
    }

    const active = tasks.filter(
      (task) => task.status !== "cancelled",
    );

    if (active.length !== 1) {
      result.conflictingStationIds.push(stationId);
      continue;
    }

    const rank = ranks[active[0]!.status];

    if (rank === undefined) {
      result.conflictingStationIds.push(stationId);
      continue;
    }

    stationRanks.push(rank);

    if (rank >= 4) result.readyStations++;
    if (rank >= 6) result.servedStations++;
  }

  if (
    result.missingStationIds.length > 0 ||
    result.conflictingStationIds.length > 0
  ) {
    return { ...result, status: "review-required" };
  }

  const minimum = Math.min(...stationRanks);

  const status: ProductionProgressStatus =
    minimum >= 6 ? "served" :
    minimum >= 5 ? "collected" :
    minimum >= 4 ? "ready" :
    minimum >= 3 ? "preparing" :
    minimum >= 2 ? "accepted" :
    "received";

  return { ...result, status };
}