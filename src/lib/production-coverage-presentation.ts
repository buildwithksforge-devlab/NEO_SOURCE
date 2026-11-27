type RecordValue = Record<string, unknown>;

export type CoverageProgress =
  | "draft"
  | "held"
  | "cancelled"
  | "cancellation-pending"
  | "coverage-unverified"
  | "review-required"
  | "received"
  | "accepted"
  | "preparing"
  | "ready"
  | "collected"
  | "served";

const ranks: Record<string, number> = {
  new: 0,
  received: 0,
  sent: 0,
  accepted: 1,
  preparing: 2,
  ready: 3,
  collected: 4,
  served: 5,
  completed: 5,
};

const stages = [
  "received",
  "accepted",
  "preparing",
  "ready",
  "collected",
  "served",
] as const;

function records(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (entry): entry is RecordValue =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry),
  );
}

export function coverageTasks(item: RecordValue) {
  return records(item["production_tasks"]);
}

export function productionCoverageProgress(
  item: RecordValue,
): CoverageProgress {
  const commercial = String(
    item["commercial_status"] ?? "",
  ).toLowerCase();

  if (["cancelled", "canceled", "voided"].includes(commercial)) {
    return "cancelled";
  }

  if (item["cancellation_pending"] === true ||
      commercial === "cancel-pending") {
    return "cancellation-pending";
  }

  if (commercial === "draft") return "draft";
  if (commercial === "held") return "held";

  const required = item["required_station_ids"];

  if (
    !Array.isArray(required) ||
    required.length === 0 ||
    required.some(
      id => typeof id !== "string" || id.trim() === "",
    )
  ) {
    return "coverage-unverified";
  }

  const requiredIds = [...new Set(required as string[])];

  const tasks = coverageTasks(item);

  if (tasks.length === 0) {
    return "coverage-unverified";
  }

  if (tasks.some(task => task["remake_of_id"] != null)) {
    return "review-required";
  }

  const stationRanks: number[] = [];

  for (const stationId of requiredIds) {

    const matching = tasks.filter(
      task => task["station_id"] === stationId,
    );

    if (matching.length === 0) {
      return "coverage-unverified";
    }

    if (matching.length !== 1) {
      return "review-required";
    }

    const status = String(
      matching[0]?.["status"] ?? "",
    ).toLowerCase();

    if (!Object.prototype.hasOwnProperty.call(ranks, status)) {
      return "review-required";
    }

    stationRanks.push(ranks[status]!);
  }

  if (
    tasks.some(
      task =>
        typeof task["station_id"] !== "string" ||
        !requiredIds.includes(task["station_id"]),
    )
  ) {
    return "review-required";
  }

  return stages[Math.min(...stationRanks)] ??
    "coverage-unverified";
}