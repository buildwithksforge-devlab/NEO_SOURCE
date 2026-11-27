import { useKitchenTicketRealtime } from "@/lib/kitchen-tickets";
import { useOrderProductionCoverage } from "@/lib/order-production-coverage";
import {
  coverageTasks,
  productionCoverageProgress,
} from "@/lib/production-coverage-presentation";

type ProductionRecord = Record<string, unknown>;

const labels: Record<string, string> = {
  draft: "Draft - not dispatched",
  new: "Received",
  sent: "Received",
  received: "Received",
  accepted: "Accepted",
  preparing: "Preparing",
  ready: "Ready",
  collected: "Collected",
  served: "Served",
  completed: "Completed",
  held: "Held",
  cancelled: "Cancelled",
  voided: "Voided",
  "cancel-pending": "Cancellation pending",
  "cancellation-pending": "Cancellation pending",
  "coverage-unverified": "Production coverage unverified",
  "review-required": "Production review required",
  "remake-requested": "Remake requested",
  remaking: "Remaking",
};

function label(value: unknown) {
  const status = String(value ?? "");
  return labels[status] ?? (status || "Unknown");
}

function record(value: unknown): ProductionRecord {
  return value !== null && typeof value === "object"
    ? (value as ProductionRecord)
    : {};
}

export function OrderProductionProgress({
  orderId,
}: {
  orderId: string;
}) {
  useKitchenTicketRealtime();

  const coverage = useOrderProductionCoverage(orderId);

  if (coverage.isLoading) {
    return (
      <section className="rounded-lg border p-3 text-sm">
        Loading production progress...
      </section>
    );
  }

  if (coverage.isError) {
    return (
      <section className="rounded-lg border p-3 text-sm">
        <p>Production progress is temporarily unavailable.</p>
        <button
          type="button"
          className="mt-2 rounded border px-3 py-1"
          onClick={() => void coverage.refetch()}
        >
          Refresh production progress
        </button>
      </section>
    );
  }

  const result = record(coverage.data);

  const items = Array.isArray(result["items"])
    ? result["items"].map(record)
    : [];

  return (
    <section className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          Live production progress
        </h3>

        <button
          type="button"
          className="rounded border px-3 py-1 text-xs"
          onClick={() => void coverage.refetch()}
          disabled={coverage.isFetching}
        >
          {coverage.isFetching ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No production items reported for this order.
        </p>
      )}

      {items.map((item, index) => {
        const tasks = coverageTasks(item);
        const progress = productionCoverageProgress(item);

        const requiresReview =
          progress === "coverage-unverified" ||
          progress === "review-required";

        return (
          <div
            key={String(item["order_item_id"] ?? index)}
            className="space-y-2 rounded border p-2"
          >
            <div className="flex justify-between gap-2 text-sm">
              <span className="font-medium">
                {String(
                  item["item_name"] ??
                  item["name"] ??
                  `Order item ${index + 1}`
                )}
              </span>

              <span>{label(progress)}</span>
            </div>

            {requiresReview && (
              <p className="text-xs text-muted-foreground">
                Complete station readiness cannot be confirmed.
              </p>
            )}

            {tasks.map((task, taskIndex) => (
              <div
                key={String(
                  task["ticket_item_id"] ?? taskIndex
                )}
                className="flex justify-between gap-2 rounded bg-muted/40 px-2 py-1 text-xs"
              >
                <span>
                  {String(
                    task["station_name"] ??
                    `Production station ${taskIndex + 1}`
                  )}
                </span>

                <span>{label(task["status"])}</span>
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}