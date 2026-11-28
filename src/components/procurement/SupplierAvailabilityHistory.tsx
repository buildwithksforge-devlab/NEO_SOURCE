import { useState } from "react";
import { SupplierRfqMessages } from "@/components/partner/SupplierRfqMessages";

import {
  useSupplierAvailabilityHistory,
} from "@/lib/supplier-availability-api";

type Invite = Record<string, unknown>;

type ResponseLine = {
  request_line_id: string;
  requested_quantity: number;
  available_quantity: number;
  unit: string;
  availability: string;
  lead_time_days: number | null;
  alternative: string | null;
  notes: string | null;
};

type AvailabilityResponse = {
  id: string;
  supplier_id: string;
  submitted_at: string;
  response_lines: ResponseLine[];
  notes: string | null;
};

export function SupplierAvailabilityHistory({
  rfqId,
  invites,
}: {
  rfqId: string;
  invites: Invite[];
}) {
  const [expanded, setExpanded] = useState(false);

  const query = useSupplierAvailabilityHistory(
    expanded ? rfqId : null
  );

  const rows = (
    query.data ?? []
  ) as unknown as AvailabilityResponse[];

  const latest = new Set<string>();

  function supplierName(id: string) {
    const invite = invites.find(
      (i) => String(i["supplier_id"]) === id
    );

    const supplier = invite?.["suppliers"] as
      | Record<string, unknown>
      | undefined;

    return String(
      supplier?.["name"] ?? "Invited supplier"
    );
  }

  return (
    <section className="mt-4 rounded-lg border border-border bg-muted/20 p-3">

      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="text-left text-sm font-semibold"
      >
        Supplier availability and alternatives
        <span className="ml-2 text-muted-foreground">
          {expanded ? "-" : "+"}
        </span>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">

          <p className="text-xs text-muted-foreground">
            Supplier availability is commercial evidence.
            It does not independently authorise a purchase,
            stock receipt or supplier payable.
          </p>

          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="rounded-md border border-border px-3 py-1 text-xs"
          >
            {query.isFetching ? "Refreshing..." : "Refresh responses"}
          </button>

          <div className="space-y-3">

            <h4 className="text-sm font-semibold">
              Invited supplier conversations
            </h4>

            {invites.map((invite) => {
              const id = String(
                invite["supplier_id"] ?? ""
              );

              if (!id) return null;

              return (
                <div key={id}>

                  <p className="text-xs font-medium">
                    {supplierName(id)}
                  </p>

                  <SupplierRfqMessages
                    rfqId={rfqId}
                    supplierId={id}
                  />

                </div>
              );
            })}

          </div>

          {query.isLoading && (
            <p className="text-sm">
              Loading supplier responses...
            </p>
          )}

          {query.isError && (
            <p role="alert" className="text-sm text-destructive">
              Supplier responses could not be loaded.
              Retry or check your procurement permissions.
            </p>
          )}

          {query.isSuccess && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No availability responses submitted yet.
            </p>
          )}

          {query.isSuccess && rows.map((response) => {
            const current = !latest.has(
              response.supplier_id
            );

            latest.add(response.supplier_id);

            return (
              <article
                key={response.id}
                className="rounded-lg border border-border bg-background p-3"
              >

                <div className="flex flex-wrap items-center justify-between gap-2">

                  <h4 className="text-sm font-semibold">
                    {supplierName(response.supplier_id)}
                  </h4>

                  <span className="rounded border border-border px-2 py-1 text-xs">
                    {current
                      ? "Latest availability response"
                      : "Previous response"}
                  </span>

                </div>

                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(
                    response.submitted_at
                  ).toLocaleString()}
                </p>

                <div className="mt-3 overflow-x-auto">

                  <table className="w-full text-left text-xs">

                    <thead className="border-b border-border">
                      <tr>
                        <th className="p-2">Requested item</th>
                        <th className="p-2">Requested</th>
                        <th className="p-2">Available</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Lead time</th>
                        <th className="p-2">Alternative</th>
                        <th className="p-2">Remarks</th>
                      </tr>
                    </thead>

                    <tbody>

                      {(response.response_lines ?? []).map((line) => (
                        <tr
                          key={line.request_line_id}
                          className="border-b border-border"
                        >

                          <td className="p-2">
                            {(line as ResponseLine & {
                              description?: string;
                            }).description ??
                              line.request_line_id}
                          </td>

                          <td className="p-2">
                            {line.requested_quantity} {line.unit}
                          </td>

                          <td className="p-2">
                            {line.available_quantity} {line.unit}
                          </td>

                          <td className="p-2 font-medium">
                            {line.availability}
                          </td>

                          <td className="p-2">
                            {line.lead_time_days === null
                              ? "Not specified"
                              : `${line.lead_time_days} days`}
                          </td>

                          <td className="p-2">
                            {line.alternative || "-"}
                          </td>

                          <td className="p-2">
                            {line.notes || "-"}
                          </td>

                        </tr>
                      ))}

                    </tbody>

                  </table>

                </div>

                {response.notes && (
                  <p className="mt-3 whitespace-pre-wrap text-sm">
                    {response.notes}
                  </p>
                )}

              </article>
            );
          })}

          {rows.length >= 200 && (
            <p className="text-xs text-muted-foreground">
              Showing the most recent 200 responses.
            </p>
          )}

        </div>
      )}

    </section>
  );
}