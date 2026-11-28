import { useState } from "react";

import { useQuery } from "@tanstack/react-query";

import {
  supabase,
} from "@/integrations/supabase/client";

import { useAuth } from "@/lib/auth";

import {
  useActivePropertyFilter,
} from "@/lib/branch-filter";

import {
  supplierLpoResponseLabel,
  type SupplierLpoResponse,
} from "@/lib/supplier-lpo-responses";

const db = supabase as any;

type RegisterRow = SupplierLpoResponse & {
  purchase_order_id: string;
  order_number: string;
  order_status: string;
  supplier_name: string;
  expected_date: string | null;
  branch_id: string;
};

export function SupplierLpoResponseRegister() {
  const {
    organizationId,
    user,
    can,
  } = useAuth();

  const { branchId } = useActivePropertyFilter();

  const [expanded,setExpanded] = useState(false);

  const [filter,setFilter] = useState("all");

  const allowed =
    can("procurement","quotations.manage") ||
    can("procurement","orders.create") ||
    can("procurement","lpos.create");

  const query = useQuery({
    queryKey: [
      "procurement-lpo-responses",
      organizationId,
      user?.id,
      branchId,
    ],

    enabled: Boolean(
      allowed &&
      expanded &&
      organizationId &&
      user?.id
    ),

    refetchInterval: expanded ? 15000 : false,

    queryFn: async () => {
      const { data,error } = await db.rpc(
        "neo_procurement_supplier_lpo_responses",
        {
          _branch: branchId ?? null,
        }
      );

      if (error) throw new Error(error.message);

      if (!Array.isArray(data)) {
        throw new Error(
          "Supplier responses could not be verified."
        );
      }

      return data as RegisterRow[];
    },
  });

  if (!allowed) return null;

  const latest = new Map<string,RegisterRow>();

  for (const row of query.data ?? []) {
    if (!latest.has(row.purchase_order_id)) {
      latest.set(row.purchase_order_id,row);
    }
  }

  const current = [...latest.values()];

  const visible = filter === "all"
    ? current
    : current.filter(
        (row) => row.response_type === filter
      );

  return (
    <section className="rounded-xl border border-border bg-card p-4">

      <button
        type="button"
        aria-expanded={expanded}
        className="w-full text-left font-semibold"
        onClick={() => setExpanded((v) => !v)}
      >
        Supplier order acknowledgements
        {expanded ? " -" : " +"}
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">

          <div className="flex flex-wrap gap-2">

            <select
              aria-label="Filter supplier responses"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm"
            >

              <option value="all">
                All responses
              </option>

              <option value="accepted">
                Accepted
              </option>

              <option value="declined">
                Declined
              </option>

              <option value="changes-requested">
                Changes requested
              </option>

            </select>

            <button
              type="button"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
              className="rounded-md border border-border px-3 py-2 text-sm"
            >
              Refresh responses
            </button>

          </div>

          {query.isLoading && (
            <p className="text-sm">
              Loading supplier acknowledgements...
            </p>
          )}

          {query.isError && (
            <p role="alert" className="text-sm text-destructive">
              Supplier acknowledgements could not be loaded.
            </p>
          )}

          {query.isSuccess && (
            <>

              <div className="grid gap-3 sm:grid-cols-3">

                {[
                  ["accepted","Accepted"],
                  ["declined","Declined"],
                  ["changes-requested","Changes requested"],
                ].map(([key,label]) => (
                  <div
                    key={key}
                    className="rounded-lg border border-border p-3"
                  >

                    <p className="text-xs text-muted-foreground">
                      {label}
                    </p>

                    <p className="mt-1 text-xl font-semibold">
                      {current.filter(
                        (row) => row.response_type === key
                      ).length}
                    </p>

                  </div>
                ))}

              </div>

              <p className="text-xs text-muted-foreground">
                Counts reflect the latest response per
                order within the loaded response history.
              </p>

              {visible.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No matching supplier acknowledgements.
                </p>
              )}

              <div className="overflow-x-auto">

                <table className="w-full text-left text-sm">

                  <thead className="border-b border-border">

                    <tr>
                      <th className="p-2">LPO</th>
                      <th className="p-2">Supplier</th>
                      <th className="p-2">Response</th>
                      <th className="p-2">Expected</th>
                      <th className="p-2">Promised</th>
                      <th className="p-2">Remarks</th>
                    </tr>

                  </thead>

                  <tbody>

                    {visible.map((row) => (
                      <tr
                        key={row.id}
                        className="border-b border-border"
                      >

                        <td className="p-2">
                          {row.order_number}
                        </td>

                        <td className="p-2">
                          {row.supplier_name}
                        </td>

                        <td className="p-2 font-medium">
                          {supplierLpoResponseLabel(
                            row.response_type
                          )}
                        </td>

                        <td className="p-2">
                          {row.expected_date ?? "-"}
                        </td>

                        <td className="p-2">

                          {row.promised_delivery_date ?? "-"}

                          {row.expected_date &&
                            row.promised_delivery_date &&
                            row.promised_delivery_date >
                              row.expected_date && (
                                <p className="text-xs text-destructive">
                                  Later than requested
                                </p>
                              )}

                        </td>

                        <td className="p-2">
                          {row.notes ?? "-"}
                        </td>

                      </tr>
                    ))}

                  </tbody>

                </table>

              </div>

              <details className="rounded-lg border border-border p-3">

                <summary className="cursor-pointer text-sm font-semibold">
                  Response history
                </summary>

                <div className="mt-3 space-y-2">

                  {(query.data ?? []).map((row) => (
                    <div
                      key={row.id}
                      className="border-b border-border pb-2 text-xs"
                    >

                      <p className="font-medium">
                        {row.order_number}
                        {" - "}
                        {row.supplier_name}
                      </p>

                      <p>
                        {supplierLpoResponseLabel(
                          row.response_type
                        )}
                      </p>

                      <p>
                        {new Date(
                          row.submitted_at
                        ).toLocaleString()}
                      </p>

                      {row.notes && (
                        <p>{row.notes}</p>
                      )}

                    </div>
                  ))}

                </div>

              </details>

              {(query.data ?? []).length >= 300 && (
                <p className="text-xs text-muted-foreground">
                  Showing the most recent 300 responses.
                </p>
              )}

            </>
          )}

          <p className="text-xs text-muted-foreground">
            Supplier responses are commercial evidence.
            Declined orders and requested changes require
            Procurement review.
          </p>

        </div>
      )}

    </section>
  );
}