import { useRef, useState } from "react";

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import {
  supabase,
} from "@/integrations/supabase/client";

import { useCustomerSession } from "@/lib/public-session";

import {
  validateSupplierLpoResponse,
  assertSupplierLpoResult,
  supplierLpoResponseLabel,
  type SupplierLpoResponse,
  type SupplierLpoResponseType,
} from "@/lib/supplier-lpo-responses";

const db = supabase as any;

type Props = {
  branchId: string;
  relationshipId: string;
  orders: Record<string, unknown>[];
};

export function SupplierLpoResponses({
  branchId,
  relationshipId,
  orders,
}: Props) {
  return (
    <section className="mt-4 space-y-3 text-white">

      <h2 className="text-base font-semibold">
        Order acknowledgements
      </h2>

      <p className="text-sm text-white/70">
        Confirm the orders you can fulfil and
        provide your expected delivery dates.
      </p>

      {orders.map((order) => {
        const number = String(
          order["order_number"] ?? ""
        );

        if (!number) return null;

        return (
          <OrderResponseForm
            key={`${branchId}:${relationshipId}:${number}`}
            branchId={branchId}
            relationshipId={relationshipId}
            number={number}
            status={String(order["status"] ?? "")}
            requestedDeliveryDate={
              order["expected_date"]
                ? String(order["expected_date"])
                : null
            }
          />
        );
      })}

    </section>
  );
}

function OrderResponseForm({
  branchId,
  relationshipId,
  number,
  status,
  requestedDeliveryDate,
}: {
  branchId: string;
  relationshipId: string;
  number: string;
  status: string;
  requestedDeliveryDate: string | null;
}) {
  const qc = useQueryClient();
  const { user } = useCustomerSession();

  const [expanded, setExpanded] = useState(false);

  const [response, setResponse] =
    useState<SupplierLpoResponseType>("accepted");

  const [deliveryDate, setDeliveryDate] =
    useState("");

  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [unresolved, setUnresolved] = useState(false);

  const busy = useRef(false);

  const attempt = useRef<{
    fingerprint: string;
    id: string;
  } | null>(null);

  const writable = [
    "approved",
    "issued",
    "sent",
    "ordered",
    "partially-received",
  ].includes(status);

  const queryKey = [
    "supplier-lpo-responses",
    user?.id,
    branchId,
    relationshipId,
    number,
  ];

  const args = {
    _branch: branchId,
    _relationship: relationshipId,
    _number: number,
  };

  const history = useQuery({
    queryKey,
    enabled: expanded && Boolean(user?.id),
    refetchInterval: expanded ? 15000 : false,

    queryFn: async () => {
      const { data, error } = await db.rpc(
        "neo_partner_supplier_lpo_responses",
        args
      );

      if (error) throw new Error(error.message);

      if (!Array.isArray(data)) {
        throw new Error(
          "Order response history could not be verified."
        );
      }

      return data as SupplierLpoResponse[];
    },
  });

  const save = useMutation({
    mutationFn: async (input: {
      response: SupplierLpoResponseType;
      deliveryDate: string | null;
      notes: string | null;
      attemptId: string;
    }) => {
      const { data, error } = await db.rpc(
        "neo_partner_supplier_lpo_respond",
        {
          ...args,
          _response: input.response,
          _delivery_date: input.deliveryDate,
          _notes: input.notes,
          _attempt: input.attemptId,
        }
      );

      if (error) throw error;

      return assertSupplierLpoResult(data);
    },
  });

  async function submit() {
    if (
      busy.current ||
      !user?.id ||
      (!writable && !unresolved)
    ) return;

    busy.current = true;
    setMessage("");

    try {
      const input = validateSupplierLpoResponse({
        response,
        deliveryDate,
        notes,
      });

      const fingerprint = JSON.stringify({
        actor: user.id,
        branchId,
        relationshipId,
        number,
        ...input,
      });

      if (
        attempt.current &&
        attempt.current.fingerprint !== fingerprint
      ) {
        throw new Error(
          "Retry the existing response before changing it."
        );
      }

      if (!attempt.current) {
        attempt.current = {
          fingerprint,
          id: crypto.randomUUID(),
        };
      }

      setUnresolved(true);

      await save.mutateAsync({
        ...input,
        attemptId: attempt.current.id,
      });

      attempt.current = null;

      setUnresolved(false);
      setMessage("Order response confirmed.");
      setNotes("");
      setDeliveryDate("");

      await Promise.all([
        qc.invalidateQueries({ queryKey }),

        qc.invalidateQueries({
          queryKey: [
            "procurement-lpo-responses",
          ],
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
            : "Order response could not be confirmed."
      );
    } finally {
      busy.current = false;
    }
  }

  const locked =
    !writable ||
    save.isPending ||
    unresolved;

  return (
    <article className="rounded-xl border border-white/20 bg-white/5 p-4">

      <button
        type="button"
        aria-expanded={expanded}
        className="w-full text-left text-sm font-semibold"
        onClick={() => setExpanded((v) => !v)}
      >
        {number} - Supplier response
        {expanded ? " -" : " +"}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">

          <p className="text-xs text-white/70">
            Order status: {status}
          </p>

          <p className="text-xs text-white/70">
            Requested delivery:
            {" "}
            {requestedDeliveryDate ?? "Not specified"}
          </p>

          {history.isLoading && (
            <p className="text-sm">
              Loading response history...
            </p>
          )}

          {history.isError && (
            <div className="space-y-2">

              <p role="alert" className="text-sm">
                Order response history could not be loaded.
              </p>

              <button
                type="button"
                onClick={() => void history.refetch()}
                className="rounded border border-white/20 px-3 py-1 text-xs"
              >
                Retry
              </button>

            </div>
          )}

          {history.isSuccess && (
            <div className="space-y-2">

              {history.data.length === 0 && (
                <p className="text-sm text-white/65">
                  No supplier acknowledgement yet.
                </p>
              )}

              {history.data.map((row,index) => (
                <div
                  key={row.id}
                  className="rounded-lg border border-white/15 p-3"
                >

                  <p className="text-sm font-semibold">
                    {supplierLpoResponseLabel(
                      row.response_type
                    )}
                    {index === 0 ? " - Latest" : ""}
                  </p>

                  <p className="text-xs text-white/65">
                    {new Date(
                      row.submitted_at
                    ).toLocaleString()}
                  </p>

                  {row.promised_delivery_date && (
                    <p className="mt-1 text-sm">
                      Delivery commitment:
                      {" "}
                      {row.promised_delivery_date}
                    </p>
                  )}

                  {row.notes && (
                    <p className="mt-1 whitespace-pre-wrap text-sm">
                      {row.notes}
                    </p>
                  )}

                </div>
              ))}

            </div>
          )}

          {(writable || unresolved) && (
            <>

              <label className="block text-xs">

                Your response

                <select
                  disabled={locked}
                  value={response}
                  onChange={(e) =>
                    setResponse(
                      e.target.value as SupplierLpoResponseType
                    )
                  }
                  className="mt-1 w-full rounded-lg border border-white/20 bg-slate-900 p-2 text-white"
                >

                  <option value="accepted">
                    Accept purchase order
                  </option>

                  {status !== "partially-received" && (
                    <option value="declined">
                      Decline purchase order
                    </option>
                  )}

                  <option value="changes-requested">
                    Request changes
                  </option>

                </select>

              </label>

              <label className="block text-xs">

                Promised delivery date

                <input
                  type="date"
                  disabled={locked}
                  value={deliveryDate}
                  onChange={(e) =>
                    setDeliveryDate(e.target.value)
                  }
                  className="mt-1 w-full rounded-lg border border-white/20 bg-slate-900 p-2 text-white"
                />

              </label>

              <label className="block text-xs">

                Delivery conditions or reason

                <textarea
                  rows={3}
                  maxLength={4000}
                  disabled={locked}
                  value={notes}
                  onChange={(e) =>
                    setNotes(e.target.value)
                  }
                  className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2"
                />

              </label>

              <button
                type="button"
                disabled={
                  save.isPending ||
                  (!history.isSuccess && !unresolved)
                }
                onClick={() => void submit()}
                className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black disabled:opacity-40"
              >

                {save.isPending
                  ? "Submitting..."
                  : unresolved
                    ? "Retry same response"
                    : "Submit order response"}

              </button>

            </>
          )}

          {!writable && !unresolved && (
            <p className="text-xs text-white/65">
              This order is no longer accepting
              new supplier acknowledgements.
            </p>
          )}

          {message && (
            <p role="status" className="text-sm">
              {message}
            </p>
          )}

          <p className="text-xs text-white/65">
            An acknowledgement does not change the
            approved order, receive stock or create
            a supplier invoice.
          </p>

        </div>
      )}

    </article>
  );
}