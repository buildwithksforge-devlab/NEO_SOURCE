import { SupplierInvoicePaymentPosition } from "@/components/partner/SupplierInvoicePaymentPosition";
import { useRef, useState } from "react";

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useCustomerSession } from "@/lib/public-session";

import {
  validateSupplierInvoiceSubmission,
  assertSupplierInvoiceSubmission,
  type SupplierInvoiceDraft,
} from "@/lib/supplier-invoice-submission";

const db = supabase as any;

type Submission = {
  id: string;
  order_number: string;
  invoice_number: string;
  invoice_date: string;
  currency: string;
  declared_amount: number;
  delivery_reference: string | null;
  notes: string | null;
  submitted_at: string;
  submission_status: string;
  review_note?: string | null;
  canonical_invoice_id?: string | null;
};

const emptyDraft: SupplierInvoiceDraft = {
  orderNumber: "",
  invoiceNumber: "",
  invoiceDate: "",
  amount: "",
  deliveryReference: "",
  notes: "",
};

export function SupplierInvoiceSubmissions({
  branchId,
  relationshipId,
  orders,
}: {
  branchId: string;
  relationshipId: string;
  orders: Record<string,unknown>[];
}) {
  const qc = useQueryClient();
  const { user } = useCustomerSession();

  const [draft,setDraft] = useState(emptyDraft);
  const [message,setMessage] = useState("");
  const [expanded,setExpanded] = useState(false);
  const [unresolved,setUnresolved] = useState(false);

  const busy = useRef(false);

  const attempt = useRef<{
    id:string;
    fingerprint:string;
  } | null>(null);

  const queryKey = [
    "supplier-invoice-submissions",
    user?.id,
    branchId,
    relationshipId,
  ];

  const history = useQuery({
    queryKey,
    enabled: Boolean(expanded && user?.id),

    queryFn: async () => {
      const {data,error} = await db.rpc(
        "neo_partner_supplier_invoice_submissions",
        {
          _branch:branchId,
          _relationship:relationshipId,
        }
      );

      if (error) throw new Error(error.message);

      if (!Array.isArray(data)) {
        throw new Error("Invalid submission history.");
      }

      return data as Submission[];
    },
  });

  const submit = useMutation({
    mutationFn: async (input: {
      draft: ReturnType<
        typeof validateSupplierInvoiceSubmission
      >;
      attemptId:string;
    }) => {
      const {data,error} = await db.rpc(
        "neo_partner_supplier_invoice_submit",
        {
          _branch:branchId,
          _relationship:relationshipId,
          _order_number:input.draft.orderNumber,
          _invoice_number:input.draft.invoiceNumber,
          _invoice_date:input.draft.invoiceDate,
          _amount:input.draft.amount,
          _delivery_reference:input.draft.deliveryReference,
          _notes:input.draft.notes,
          _attempt:input.attemptId,
        }
      );

      if (error) throw error;

      return assertSupplierInvoiceSubmission(data);
    },
  });

  const eligible = orders.filter((order) =>
    [
      "approved",
      "issued",
      "sent",
      "ordered",
      "partially-received",
      "received",
      "partially-invoiced",
      "fully-invoiced",
      "completed",
      "closed",
    ].includes(String(order["status"]))
  );

  function change(
    field:keyof SupplierInvoiceDraft,
    value:string
  ) {
    setDraft((old) => ({
      ...old,
      [field]:value,
    }));
  }

  async function send() {
    if (busy.current || !user?.id) return;

    busy.current = true;
    setMessage("");

    try {
      const validated = validateSupplierInvoiceSubmission(
        draft
      );

      const fingerprint = JSON.stringify({
        user:user.id,
        branchId,
        relationshipId,
        validated,
      });

      if (
        attempt.current &&
        attempt.current.fingerprint !== fingerprint
      ) {
        throw new Error(
          "Retry the existing invoice before changing it."
        );
      }

      if (!attempt.current) {
        attempt.current = {
          id:crypto.randomUUID(),
          fingerprint,
        };
      }

      setUnresolved(true);

      const result = await submit.mutateAsync({
        draft:validated,
        attemptId:attempt.current.id,
      });

      attempt.current = null;

      setUnresolved(false);
      setDraft(emptyDraft);

      setMessage(
        `Invoice submitted for verification. Reference: ${result}`
      );

      await Promise.all([
        qc.invalidateQueries({queryKey}),
        qc.invalidateQueries({
          queryKey:["supplier-invoice-submission-register"],
        }),
      ]);

    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : typeof error === "object" &&
              error !== null &&
              "message" in error
            ? String(error.message)
            : "Invoice submission could not be confirmed."
      );
    } finally {
      busy.current = false;
    }
  }

  const locked = submit.isPending || unresolved;

  const inputClass =
    "mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2 text-white";

  return (
    <section className="mt-4 rounded-xl border border-white/20 p-4 text-white">

      <button
        type="button"
        aria-expanded={expanded}
        className="w-full text-left font-semibold"
        onClick={() => setExpanded((v) => !v)}
      >
        Submit a supplier invoice
        {expanded ? " -" : " +"}
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">

          <p className="text-sm text-white/70">
            Send invoice details against an existing
            purchase order. Submission is not acceptance
            of the invoice or confirmation of payment.
          </p>

          <label className="block text-xs">
            Purchase order

            <select
              disabled={locked}
              value={draft.orderNumber}
              onChange={(e) =>
                change("orderNumber",e.target.value)
              }
              className={`${inputClass} bg-slate-900`}
            >
              <option value="">Select purchase order</option>

              {eligible.map((order) => {
                const number = String(
                  order["order_number"] ?? ""
                );

                return number ? (
                  <option key={number} value={number}>
                    {number}
                  </option>
                ) : null;
              })}

            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">

            <label className="text-xs">
              Invoice number

              <input
                maxLength={120}
                disabled={locked}
                value={draft.invoiceNumber}
                onChange={(e) =>
                  change("invoiceNumber",e.target.value)
                }
                className={inputClass}
              />

            </label>

            <label className="text-xs">
              Invoice date

              <input
                type="date"
                disabled={locked}
                value={draft.invoiceDate}
                onChange={(e) =>
                  change("invoiceDate",e.target.value)
                }
                className={inputClass}
              />

            </label>

            <label className="text-xs">
              Total invoice amount (LPO currency)

              <input
                inputMode="decimal"
                disabled={locked}
                value={draft.amount}
                onChange={(e) =>
                  change("amount",e.target.value)
                }
                className={inputClass}
              />

            </label>

            <label className="text-xs">
              Delivery note or GRN reference

              <input
                maxLength={200}
                disabled={locked}
                value={draft.deliveryReference}
                onChange={(e) =>
                  change("deliveryReference",e.target.value)
                }
                className={inputClass}
              />

            </label>

          </div>

          <label className="block text-xs">
            Additional notes

            <textarea
              rows={3}
              maxLength={4000}
              disabled={locked}
              value={draft.notes}
              onChange={(e) =>
                change("notes",e.target.value)
              }
              className={inputClass}
            />

          </label>

          <button
            type="button"
            disabled={
              submit.isPending ||
              (!eligible.length && !unresolved) ||
              !user?.id
            }
            onClick={() => void send()}
            className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black disabled:opacity-40"
          >
            {submit.isPending
              ? "Submitting..."
              : unresolved
                ? "Retry same invoice"
                : "Submit for verification"}
          </button>

          {message && (
            <p role="status" className="break-all text-sm">
              {message}
            </p>
          )}

          <div className="border-t border-white/20 pt-4">

            <h3 className="text-sm font-semibold">
              Your invoice submissions
            </h3>

            <button
              type="button"
              onClick={() => void history.refetch()}
              disabled={history.isFetching}
              className="mt-2 rounded border border-white/20 px-3 py-1 text-xs"
            >
              Refresh submissions
            </button>

            {history.isLoading && (
              <p className="mt-2 text-sm">Loading...</p>
            )}

            {history.isError && (
              <p role="alert" className="mt-2 text-sm">
                Submission history could not be loaded.
              </p>
            )}

            {history.isSuccess &&
              history.data.length === 0 && (
                <p className="mt-2 text-sm">
                  No invoices submitted yet.
                </p>
            )}

            {history.isSuccess && history.data.map((row) => (
              <article
                key={row.id}
                className="mt-3 rounded-lg border border-white/15 p-3"
              >

                <p className="text-sm font-semibold">
                  {row.invoice_number}
                </p>

                <p className="text-xs text-white/70">
                  {row.order_number} - {row.invoice_date}
                </p>

                <p className="mt-2 text-sm">
                  {row.currency}
                  {" "}
                  {Number(row.declared_amount).toLocaleString(
                    undefined,
                    {
                      minimumFractionDigits:2,
                      maximumFractionDigits:2,
                    }
                  )}
                </p>

                <p className="mt-1 text-xs text-white/70">
                  Review status: {row.submission_status}
                  {row.review_note && (
                    <span className="mt-1 block">
                      {row.review_note}
                    </span>
                  )}
                  {row.canonical_invoice_id && (
                    <span className="mt-1 block">
                      Linked to the official supplier invoice.
                    </span>
                  )}
                  {row.canonical_invoice_id && (
                    <SupplierInvoicePaymentPosition
                      branchId={branchId}
                      relationshipId={relationshipId}
                      submissionId={row.id}
                    />
                  )}
                </p>

              </article>
            ))}

          </div>

        </div>
      )}

    </section>
  );
}