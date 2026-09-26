/**
 * Requisition Workspace — the one shape a "request" takes everywhere it is
 * seen: Stores/Inventory, Procurement, Delivery. A summary strip of figures,
 * a single grouped list of requests, and an inspector sheet for the selected
 * request (header, line items, availability, approval/issue trail, actions).
 *
 * Presentational only — it owns no data fetching and no lifecycle rules.
 * Callers pass typed rows, an inspector renderer, and whatever actions their
 * own permissions allow; the same primitive renders identically regardless of
 * which route composes it, so a request looks and behaves the same wherever
 * it is seen. Only the actions rendered by the caller differ by role.
 */
import type { ReactNode } from "react";

import { SummaryStrip, type SummaryFigure } from "@/components/common/SummaryStrip";
import { CatalogueGroup, CatalogueRow } from "@/components/common/CatalogueWorkspace";
import {
  InspectorField,
  InspectorSection,
  InspectorSheet,
} from "@/components/common/InspectorSheet";
import { QueryState } from "@/components/common/StateSystem";

/** One request in the list half of the workspace. */
export type RequisitionRow = {
  id: string;
  title: string;
  subtitle?: ReactNode;
  chips?: ReactNode;
  trailing?: ReactNode;
  /** Optional lane/status label the row is grouped under. Omit to leave flat. */
  group?: string;
};

/** One line item inside the inspector's line-items section. */
export type RequisitionLineRow = {
  id: string;
  name: string;
  unit?: ReactNode;
  requested?: ReactNode;
  outstanding?: ReactNode;
  available?: ReactNode;
  shortage?: boolean;
  /** Inline control for the line — e.g. an "issue now" quantity field. */
  control?: ReactNode;
};

/** The content the inspector shows for one selected request. */
export type RequisitionInspectorContent = {
  title: string;
  subtitle?: string;
  chips?: ReactNode;
  /** Header fields, availability, approval/issue trail — anything the caller wants. */
  sections: ReactNode;
  /** Action buttons, gated by the caller's own permission checks. */
  footer?: ReactNode;
};

/**
 * Renders a table of line items using the shared InspectorField shape. Purely
 * a layout helper — callers may render their own markup instead if a line
 * needs more than these columns.
 */
export function RequisitionLineItems({ lines }: { lines: RequisitionLineRow[] }) {
  return (
    <div className="neo-table-scroll -mx-1 px-1">
      <table className="w-full min-w-[32rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-outline-subtle text-left text-xs uppercase tracking-[0.08em] text-muted-foreground">
            <th className="py-1.5 pr-2 font-semibold">Item</th>
            <th className="py-1.5 pr-2 text-right font-semibold">Requested</th>
            <th className="py-1.5 pr-2 text-right font-semibold">Outstanding</th>
            <th className="py-1.5 pr-2 text-right font-semibold">Available</th>
            <th className="py-1.5 pl-2 text-right font-semibold">Issue now</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-outline-subtle">
          {lines.map((line) => (
            <tr key={line.id}>
              <td className="py-2 pr-2">
                <p className="neo-line-1 font-medium text-foreground">{line.name}</p>
                {line.unit ? (
                  <p className="neo-line-1 text-xs text-muted-foreground">{line.unit}</p>
                ) : null}
              </td>
              <td className="neo-atomic py-2 pr-2 text-right">{line.requested ?? "—"}</td>
              <td className="neo-atomic py-2 pr-2 text-right">{line.outstanding ?? "—"}</td>
              <td
                className={
                  "neo-atomic py-2 pr-2 text-right " +
                  (line.shortage ? "text-destructive" : "")
                }
              >
                {line.available ?? "—"}
              </td>
              <td className="py-2 pl-2 text-right">{line.control ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RequisitionWorkspace({
  lead,
  figures,
  summaryActions,
  isLoading,
  error,
  rows,
  emptyState,
  selectedId,
  onSelect,
  renderInspector,
  className,
}: {
  /** The single headline figure of the screen. */
  lead: SummaryFigure;
  figures?: SummaryFigure[];
  summaryActions?: ReactNode;
  isLoading: boolean;
  error: unknown;
  rows: RequisitionRow[];
  emptyState: ReactNode;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Returns the inspector content for the selected id, or null once it has been resolved away. */
  renderInspector: (id: string) => RequisitionInspectorContent | null;
  className?: string;
}) {
  const groups = new Map<string, RequisitionRow[]>();
  for (const row of rows) {
    const key = row.group ?? "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  const entries = [...groups.entries()];
  const inspected = selectedId ? renderInspector(selectedId) : null;

  return (
    <div className={className}>
      <SummaryStrip lead={lead} figures={figures} actions={summaryActions} />

      <QueryState
        isLoading={isLoading}
        error={error}
        isEmpty={rows.length === 0}
        empty={emptyState}
      >
        <div className="space-y-5">
          {entries.map(([label, items]) =>
            label ? (
              <CatalogueGroup key={label} label={label} count={items.length}>
                {items.map((r) => (
                  <CatalogueRow
                    key={r.id}
                    title={r.title}
                    subtitle={r.subtitle}
                    chips={r.chips}
                    trailing={r.trailing}
                    onOpen={() => onSelect(r.id)}
                    selected={r.id === selectedId}
                  />
                ))}
              </CatalogueGroup>
            ) : (
              <ul key="__ungrouped" className="divide-y divide-outline-subtle">
                {items.map((r) => (
                  <CatalogueRow
                    key={r.id}
                    title={r.title}
                    subtitle={r.subtitle}
                    chips={r.chips}
                    trailing={r.trailing}
                    onOpen={() => onSelect(r.id)}
                    selected={r.id === selectedId}
                  />
                ))}
              </ul>
            ),
          )}
        </div>
      </QueryState>

      <InspectorSheet
        open={Boolean(inspected)}
        onOpenChange={(open) => {
          if (!open) onSelect(null);
        }}
        title={inspected?.title ?? ""}
        subtitle={inspected?.subtitle}
        chips={inspected?.chips}
        footer={inspected?.footer}
      >
        {inspected?.sections}
      </InspectorSheet>
    </div>
  );
}

export { InspectorField, InspectorSection };
