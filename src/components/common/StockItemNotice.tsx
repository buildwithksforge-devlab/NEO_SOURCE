import { AlertTriangle } from "lucide-react";
import { isDegradedStockItems } from "@/lib/fnb";

/**
 * Recovery notice for the Stores catalogue picker.
 *
 * When the catalogue query fails or falls back to a reduced projection, the
 * requisition stays usable: staff pick the item they can see (or the free-text
 * option) and type the unit by hand, instead of losing the whole screen.
 */
export function StockItemNotice({
  query,
}: {
  query: { isError?: boolean; error?: unknown; data?: unknown };
}) {
  const failed = Boolean(query.isError);
  const degraded = isDegradedStockItems(query.data);
  if (!failed && !degraded) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-foreground"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div>
        <p className="font-medium">
          {failed
            ? "Stores catalogue unavailable"
            : "Stores catalogue loaded with limited detail"}
        </p>
        <p className="text-muted-foreground">
          {failed
            ? "Pick “Not in Stores catalogue” and describe the item — the requisition still submits and Stores can match it on issue."
            : "Units are missing for these items, so enter the unit by hand before submitting."}
        </p>
      </div>
    </div>
  );
}
