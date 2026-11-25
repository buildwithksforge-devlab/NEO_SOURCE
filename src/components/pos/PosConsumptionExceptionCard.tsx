import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export type PosConsumptionException = {
  order_id: string;
  order_number: string;
  order_status: string;
  order_item_id: string;
  menu_item_id: string | null;
  item_name: string;
  item_quantity: number;
  item_status: string;
  branch_id: string;
  consumption_mode: string;
  order_channel: string;
  posting_status: string | null;
  exception_category: string;
  posting_details: Record<string, unknown> | null;
  last_posting_at: string | null;
  item_created_at: string;
};

const CATEGORY_LABELS: Record<string, string> = {
  CONFIGURED_NO_CONSUMPTION: "Consumption disabled",
  CHANNEL_EXCLUDED: "Sales channel excluded",
  FAILED_POSTING: "Stock posting failed",
  SKIPPED_POSTING_REVIEW: "Posting skipped",
  NO_POSTING_EVENT: "No posting event",
  NOT_POSTED_REVIEW: "Requires stock review",
};

function formatCategory(category: string) {
  return CATEGORY_LABELS[category] ?? category;
}

export function usePosConsumptionExceptions() {
  const { organizationId, user } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();

  return useQuery({
    queryKey: [
      "pos",
      "consumption-exceptions",
      organizationId,
      user?.id,
      filterKey,
      branchId,
    ],

    enabled: Boolean(organizationId && user?.id),

    refetchInterval: 30_000,

    queryFn: async (): Promise<PosConsumptionException[]> => {
      const { data, error } = await supabase.rpc(
        "neo_pos_consumption_exception_queue" as never,
        {
          _branch: branchId ?? null,
          _limit: 100,
        } as never,
      );

      if (error) throw error;

      return (data ?? []) as PosConsumptionException[];
    },
  });
}

function classifyStockException(row: PosConsumptionException) {
  const details = JSON.stringify(row.posting_details ?? {}).toLowerCase();
  const closed = ["closed", "paid", "completed"].includes(
    row.order_status.toLowerCase()
  );

  const paymentWarning =
    "Preserve existing payment evidence. Do not collect payment again, " +
    "automatically retry historical deductions, or adjust stock without reconciliation.";

  if (
    row.exception_category === "CHANNEL_EXCLUDED" ||
    row.exception_category === "CONFIGURED_NO_CONSUMPTION"
  ) {
    return {
      severity: "INFORMATIONAL",
      owner: "Menu Configuration / Inventory",
      action:
        "Verify that the product was intentionally excluded from consumption " +
        "when the original sale occurred.",
      paymentWarning,
    };
  }

  if (
    row.exception_category === "FAILED_POSTING" ||
    row.posting_status === "failed"
  ) {
    let action =
      "Investigate the original stock posting, recipe snapshot, " +
      "department store and inventory movement ledger.";

    if (/insufficient|shortfall|not enough|available/.test(details)) {
      action =
        "Check departmental stock availability and investigate the shortage.";
    } else if (/conversion|unit|gram|piece|nan|infinity/.test(details)) {
      action =
        "Correct the recipe or stock-unit configuration after verifying " +
        "the original sale and ingredient quantities.";
    } else if (/pour|volume|container/.test(details)) {
      action =
        "Verify whether the product is configured for sealed-unit sales " +
        "or measured pours.";
    } else if (/recipe|ingredient|location|store/.test(details)) {
      action =
        "Verify active recipe, frozen ingredients and production-station store mapping.";
    }

    return {
      severity: "CRITICAL",
      owner: "Inventory Supervisor / POS Operations",
      action: closed
        ? "Closed or settled order with failed stock posting. " + action
        : action,
      paymentWarning,
    };
  }

  if (row.exception_category === "NO_POSTING_EVENT") {
    return {
      severity: "CRITICAL",
      owner: "Inventory Supervisor / POS Operations",
      action:
        "Compare the original order with stock_movements and posting events. " +
        "Missing posting evidence does not necessarily mean stock was not deducted.",
      paymentWarning,
    };
  }

  return {
    severity: "REVIEW",
    owner: "Inventory Supervisor",
    action:
      "Review the posting status, original consumption policy and stock ledger " +
      "before deciding whether corrective action is necessary.",
    paymentWarning,
  };
}
export function PosConsumptionExceptionCard() {
  const exceptions = usePosConsumptionExceptions();

  const rows = exceptions.data ?? [];

  const failed = rows.filter(
    (row) => row.exception_category === "FAILED_POSTING",
  ).length;

  const missing = rows.filter(
    (row) => row.exception_category === "NO_POSTING_EVENT",
  ).length;

  return (
    <section className="rounded-xl border bg-card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            Stock Consumption Exceptions
          </h2>

          <p className="text-sm text-muted-foreground">
            POS orders requiring inventory reconciliation review.
            Read-only: no stock deductions are performed here.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void exceptions.refetch()}
          disabled={exceptions.isFetching}
          className="rounded-md border px-3 py-2 text-sm"
        >
          {exceptions.isFetching ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {exceptions.isLoading ? (
        <p className="text-sm">Loading stock exceptions...</p>
      ) : exceptions.isError ? (
        <div role="alert" className="rounded-lg border p-3 text-sm">
          <p className="font-medium">
            Stock exception register unavailable
          </p>

          <p className="mt-1">
            {exceptions.error instanceof Error
              ? exceptions.error.message
              : "Unable to retrieve stock exceptions."}
          </p>

          <p className="mt-2 text-muted-foreground">
            This register requires organization administrator access.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">
                Exceptions returned
              </p>
              <p className="text-2xl font-semibold">{rows.length}</p>
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">
                Failed postings
              </p>
              <p className="text-2xl font-semibold">{failed}</p>
            </div>

            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">
                Missing posting events
              </p>
              <p className="text-2xl font-semibold">{missing}</p>
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="rounded-lg border p-4 text-sm">
              No consumption exceptions were returned.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-3">Order</th>
                    <th className="p-3">Item</th>
                    <th className="p-3">Quantity</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Exception</th>
                    <th className="p-3">Details</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.order_item_id}
                      className="border-t align-top"
                    >
                      <td className="p-3 font-mono text-xs">
                        {row.order_number}
                      </td>

                      <td className="p-3">{row.item_name}</td>

                      <td className="p-3">{row.item_quantity}</td>

                      <td className="p-3">{row.item_status}</td>

                      <td className="p-3">
                        <div className="space-y-2">
                          <div className="font-medium">
                            {formatCategory(row.exception_category)}
                          </div>
                          <div className="text-xs font-semibold">
                            {classifyStockException(row).severity}
                          </div>
                          <div className="text-xs">
                            <strong>Responsible:</strong>{" "}
                            {classifyStockException(row).owner}
                          </div>
                          <div className="text-xs">
                            <strong>Action:</strong>{" "}
                            {classifyStockException(row).action}
                          </div>
                        </div>
                      </td>

                      <td className="p-3 max-w-xs">
                        <details>
                          <summary className="cursor-pointer">
                            View evidence
                          </summary>

                          <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words text-xs">
                            {JSON.stringify(
                              {
                                posting_status: row.posting_status,
                                posting_details: row.posting_details,
                                order_status: row.order_status,
                                consumption_mode: row.consumption_mode,
                                order_channel: row.order_channel,
                                branch_id: row.branch_id,
                                last_posting_at: row.last_posting_at,
                              },
                              null,
                              2,
                            )}
                          </pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Showing up to 100 exceptions. Counts describe returned
            records, not necessarily every exception in the database.
Historical postings are never retried automatically.
            Preserve valid customer payments. Never collect payment twice
            or create stock adjustments without reconciliation.
          </p>
        </>
      )}
    </section>
  );
}