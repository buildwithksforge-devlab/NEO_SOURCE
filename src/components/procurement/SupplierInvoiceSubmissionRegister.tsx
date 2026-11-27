import { SupplierSubmissionCapture } from "@/components/procurement/SupplierSubmissionCapture";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

const db = supabase as any;

type Submission = {
  id:string;
  supplier_name:string;
  order_number:string;
  invoice_number:string;
  invoice_date:string;
  currency:string;
  declared_amount:number;
  delivery_reference:string | null;
  notes:string | null;
  submitted_at:string;
  review_status:string;
  review_note?:string | null;
  canonical_invoice_id?:string | null;
};

export function SupplierInvoiceSubmissionRegister() {
  const {organizationId,user,can} = useAuth();
  const {branchId} = useActivePropertyFilter();

  const [expanded,setExpanded] = useState(false);

  const qc = useQueryClient();

  const [reviewId,setReviewId] = useState<string | null>(null);

  const [decision,setDecision] = useState("under-review");

  const [reason,setReason] = useState("");

  const [reviewMessage,setReviewMessage] = useState("");

  const mayReview = can("finance","edit");

  const review = useMutation({
    mutationFn: async (input: {
      id:string;
      decision:string;
      reason:string;
    }) => {
      const {data,error} = await db.rpc(
        "neo_supplier_submission_review",
        {
          _submission:input.id,
          _decision:input.decision,
          _reason:input.reason,
        }
      );

      if (error) throw new Error(error.message);

      if (
        data?.ok !== true ||
        data?.submission_id !== input.id ||
        data?.review_status !== input.decision
      ) {
        throw new Error("Review outcome could not be confirmed.");
      }

      return data;
    },

    onSuccess: async () => {
      setReviewId(null);
      setReason("");
      setReviewMessage("Review decision recorded.");

      await Promise.all([
        qc.invalidateQueries({
          queryKey:["supplier-invoice-submission-register"],
        }),
        qc.invalidateQueries({
          queryKey:["supplier-invoice-submissions"],
        }),
      ]);
    },

    onError: (error:Error) => {
      setReviewMessage(error.message);
    },
  });

  const allowed =
    can("finance","view") ||
    can("procurement","quotations.manage") ||
    can("procurement","orders.create");

  const query = useQuery({
    queryKey:[
      "supplier-invoice-submission-register",
      organizationId,
      user?.id,
      branchId,
    ],

    enabled:Boolean(
      allowed &&
      expanded &&
      organizationId &&
      user?.id
    ),

    refetchInterval:expanded ? 30000 : false,

    queryFn:async () => {
      const {data,error} = await db.rpc(
        "neo_supplier_invoice_submission_register",
        {
          _branch:branchId ?? null,
        }
      );

      if (error) throw new Error(error.message);

      if (!Array.isArray(data)) {
        throw new Error("Invalid supplier submission register.");
      }

      return data as Submission[];
    },
  });

  if (!allowed) return null;

  return (
    <section className="rounded-xl border border-border bg-card p-4">

      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left font-semibold"
      >
        Supplier invoice submissions
        {expanded ? " -" : " +"}
      </button>

      {expanded && (
        <div className="mt-4 space-y-3">

          <p className="text-sm text-muted-foreground">
            Commercial invoice details received from
            suppliers. These records are not approved
            supplier invoices or accounts payable.
          </p>

          <button
            type="button"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
            className="rounded border border-border px-3 py-1 text-xs"
          >
            Refresh submissions
          </button>

          {mayReview && reviewId && (
            <SupplierSubmissionCapture
              key={reviewId}
              submissionId={reviewId}
            />
          )}

          {mayReview && reviewId && (
            <div className="space-y-3 rounded-lg border border-border p-4">

              <h3 className="text-sm font-semibold">
                Finance review decision
              </h3>

              <label className="block text-xs">
                Decision

                <select
                  value={decision}
                  disabled={review.isPending}
                  onChange={(e) =>
                    setDecision(e.target.value)
                  }
                  className="mt-1 w-full rounded border border-input bg-background p-2"
                >
                  <option value="under-review">
                    Under review
                  </option>

                  <option value="returned">
                    Return for correction
                  </option>

                  <option value="rejected">
                    Reject submission
                  </option>
                </select>

              </label>

              <label className="block text-xs">
                Review reason

                <textarea
                  rows={3}
                  maxLength={4000}
                  disabled={review.isPending}
                  value={reason}
                  onChange={(e) =>
                    setReason(e.target.value)
                  }
                  className="mt-1 w-full rounded border border-input bg-background p-2"
                />
              </label>

              <div className="flex gap-2">

                <button
                  type="button"
                  disabled={
                    review.isPending ||
                    reason.trim().length < 5
                  }
                  onClick={() => {
                    if (!reviewId || review.isPending) return;

                    setReviewMessage("");

                    review.mutate({
                      id:reviewId,
                      decision,
                      reason:reason.trim(),
                    });
                  }}
                  className="rounded border border-border px-4 py-2 text-sm font-medium disabled:opacity-40"
                >
                  {review.isPending
                    ? "Saving..."
                    : "Record decision"}
                </button>

                <button
                  type="button"
                  disabled={review.isPending}
                  onClick={() => {
                    setReviewId(null);
                    setReason("");
                  }}
                  className="rounded border border-border px-4 py-2 text-sm"
                >
                  Cancel
                </button>

              </div>

              <p className="text-xs text-muted-foreground">
                A review decision does not approve or post
                an accounts payable transaction.
              </p>

            </div>
          )}

          {reviewMessage && (
            <p role="status" className="text-sm">
              {reviewMessage}
            </p>
          )}

          {query.isLoading && (
            <p className="text-sm">Loading submissions...</p>
          )}

          {query.isError && (
            <p role="alert" className="text-sm text-destructive">
              Supplier invoice submissions could not load.
            </p>
          )}

          {query.isSuccess &&
            query.data.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No supplier invoices submitted yet.
              </p>
            )}

          {query.isSuccess && (
            <div className="overflow-x-auto">

              <table className="w-full text-left text-sm">

                <thead className="border-b border-border">
                  <tr>
                    <th className="p-2">Supplier</th>
                    <th className="p-2">LPO</th>
                    <th className="p-2">Invoice</th>
                    <th className="p-2">Date</th>
                    <th className="p-2">Declared amount</th>
                    <th className="p-2">Delivery reference</th>
                    <th className="p-2">Notes</th>
                    <th className="p-2">Review status</th>
                  </tr>
                </thead>

                <tbody>

                  {query.data.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-border"
                    >
                      <td className="p-2">{row.supplier_name}</td>
                      <td className="p-2">{row.order_number}</td>
                      <td className="p-2">{row.invoice_number}</td>
                      <td className="p-2">{row.invoice_date}</td>

                      <td className="p-2">
                        {row.currency}
                        {" "}
                        {Number(row.declared_amount).toLocaleString(
                          undefined,
                          {
                            minimumFractionDigits:2,
                            maximumFractionDigits:2,
                          }
                        )}
                      </td>

                      <td className="p-2">
                        {row.delivery_reference ?? "-"}
                      </td>

                      <td className="p-2">
                        {row.notes ?? "-"}
                      </td>

                      <td className="p-2">

                        <p className="font-medium">
                          {row.review_status}
                        </p>

                        {row.review_note && (
                          <p className="text-xs text-muted-foreground">
                            {row.review_note}
                          </p>
                        )}

                        {row.canonical_invoice_id && (
                          <p className="text-xs">
                            Official invoice linked
                          </p>
                        )}

                        {mayReview &&
                          !row.canonical_invoice_id &&
                          !["captured","rejected"].includes(
                            row.review_status
                          ) && (
                            <button
                              type="button"
                              disabled={review.isPending}
                              onClick={() => {
                                setReviewId(row.id);
                                setDecision("under-review");
                                setReason("");
                                setReviewMessage("");
                              }}
                              className="mt-2 rounded border border-border px-3 py-1 text-xs"
                            >
                              Review submission
                            </button>
                          )}

                      </td>

                    </tr>
                  ))}

                </tbody>

              </table>

            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Finance must verify the supplier invoice
            against the LPO and accepted goods before
            capturing or approving the payable.
          </p>

        </div>
      )}

    </section>
  );
}