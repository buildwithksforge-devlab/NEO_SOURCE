import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

type EvidenceRow = Record<string, unknown>;

export function InventoryFinanceReconciliationCard() {
  const { organizationId, user } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();
  const client = useQueryClient();

  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const queryKey = [
    "finance",
    "inventory-reconciliation",
    organizationId,
    user?.id,
    branchId,
    filterKey,
  ];

  const evidence = useQuery({
    queryKey,
    enabled: Boolean(organizationId && user?.id),
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "neo_inventory_finance_exceptions" as never,
        { _limit: 100, _branch: branchId ?? null } as never
      );

      if (error) throw error;

      return data as unknown;
    },
  });

  const payload =
    evidence.data &&
    typeof evidence.data === "object" &&
    !Array.isArray(evidence.data)
      ? evidence.data as Record<string, unknown>
      : null;

  const groups = payload
    ? Object.entries(payload).filter(
        ([, value]) => Array.isArray(value)
      )
    : [];

  async function retry(
    row: EvidenceRow,
    kind: "consumption" | "restoration"
  ) {
    const id = String(
      kind === "consumption"
        ? row["event_id"] ?? row["id"] ?? ""
        : row["reversal_id"] ?? row["id"] ?? ""
    );

    if (!id || busy) return;

    if (!window.confirm(
      "Retry accounting only? This does not authorise a new stock movement or payment."
    )) return;

    setBusy(id);
    setNotice("");

    try {
      const result = kind === "consumption"
        ? await supabase.rpc(
            "neo_retry_inventory_consumption_finance" as never,
            { _event_id: id } as never
          )
        : await supabase.rpc(
            "neo_retry_inventory_restoration_finance" as never,
            { _reversal_id: id } as never
          );

      if (result.error) throw result.error;

      const outcome =
        result.data as unknown as Record<string, unknown>;

      const status = String(
        outcome?.["status"] ?? "requires-verification"
      );

      setNotice("Accounting retry outcome: " + status);

      await client.invalidateQueries({
        queryKey,
      });

    } catch (cause) {

      setNotice(
        cause instanceof Error
          ? cause.message
          : String(
              (cause as { message?: string })?.message ??
              "Accounting retry failed"
            )
      );

    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-4 rounded-xl border p-4">
      <div>
        <h2 className="font-semibold">
          Inventory financial reconciliation
        </h2>
        <p className="text-sm text-muted-foreground">
          Review unresolved inventory valuation and journal evidence. Results are limited to the latest records returned by the server.
          Retrying accounting does not authorise a new stock deduction.
        </p>
      </div>

      {evidence.isLoading && <p>Loading accounting evidence...</p>}

      {evidence.error && (
        <p role="alert" className="text-sm text-destructive">
          Inventory accounting evidence could not be loaded.
        </p>
      )}

      {notice && <p role="status">{notice}</p>}

      {evidence.isSuccess && groups.length === 0 && (
        <p className="text-sm">
          No recognised reconciliation groups returned.
          Verify the database reporting contract.
        </p>
      )}

      {groups.map(([key, value]) => {
        const kind = key.includes("restoration") ||
          key.includes("reversal")
          ? "restoration"
          : key.includes("consumption")
            ? "consumption"
            : null;

        const rows = (value as EvidenceRow[]).filter(
          row => !branchId || row["branch_id"] === branchId
        );

        return (
          <div key={key} className="space-y-2">
            <h3 className="font-medium">
              {key.replace(/_/g, " ")}
            </h3>

            {rows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No exceptions returned for this property in the current result window.
              </p>
            )}

            {rows.map((row, index) => (
              <div
                key={String(row["id"] ?? row["event_id"] ?? index)}
                className="space-y-2 rounded-lg border p-3"
              >
                <div className="text-sm font-medium">
                  {String(
                    row["finance_posting_status"] ??
                    row["status"] ??
                    "Requires review"
                  )}
                </div>

                <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">
                  {JSON.stringify(row, null, 2)}
                </pre>

                {kind && (
                  <button
                    type="button"
                    disabled={Boolean(busy)}
                    className="rounded-md border px-3 py-2 text-sm"
                    onClick={() => void retry(row, kind)}
                  >
                    Retry accounting
                  </button>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </section>
  );
}