import { useCustomerSession } from "@/lib/public-session";
import { useRef, useState } from "react";

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";

import {
  supabase,
} from "@/integrations/supabase/client";

import {
  validateSupplierMessage,
  assertSupplierMessageResult,
  parseSupplierMessages,
} from "@/lib/supplier-rfq-messages";

const db = supabase as any;

type Props = {
  rfqId: string;
  supplierId?: string;
  relationshipId?: string;
  branchId?: string;
};

export function SupplierRfqMessages(props: Props) {
  const qc = useQueryClient();
  const { user } = useCustomerSession();

  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");
  const [unresolved, setUnresolved] = useState(false);

  const busy = useRef(false);

  const attempt = useRef<{
    id: string;
    body: string;
  } | null>(null);

  const args = {
    _rfq: props.rfqId,
    _supplier: props.supplierId ?? null,
    _relationship: props.relationshipId ?? null,
    _branch: props.branchId ?? null,
  };

  const queryKey = [
    "supplier-rfq-messages",
    user?.id,
    props.rfqId,
    props.supplierId,
    props.relationshipId,
    props.branchId,
  ];

  const thread = useQuery({
    queryKey,

    enabled:
      expanded && Boolean(user?.id) &&
      Boolean(props.rfqId) &&
      Boolean(
        props.supplierId ||
        props.relationshipId
      ),

    refetchInterval: expanded ? 15000 : false,

    queryFn: async () => {
      const { data, error } = await db.rpc(
        "neo_supplier_rfq_message_history",
        args
      );

      if (error) throw new Error(error.message);

      return parseSupplierMessages(data);
    },
  });

  const send = useMutation({
    mutationFn: async (input: {
      body: string;
      attemptId: string;
    }) => {
      const { data, error } = await db.rpc(
        "neo_supplier_rfq_message_send",
        {
          ...args,
          _message: input.body,
          _attempt: input.attemptId,
        }
      );

      if (error) throw new Error(error.message);

      return assertSupplierMessageResult(data);
    },
  });

  async function submit() {
    if (busy.current || !user?.id) return;

    busy.current = true;
    setMessage("");

    try {
      const text = validateSupplierMessage(body);

      if (
        attempt.current &&
        attempt.current.body !== text
      ) {
        throw new Error(
          "Retry the existing message before editing it."
        );
      }

      if (!attempt.current) {
        attempt.current = {
          body: text,
          id: crypto.randomUUID(),
        };
      }

      setUnresolved(true);

      await send.mutateAsync({
        body: text,
        attemptId: attempt.current.id,
      });

      attempt.current = null;
      setUnresolved(false);
      setBody("");
      setMessage("Message sent.");

      await qc.invalidateQueries({
        queryKey,
      });

    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Message could not be confirmed."
      );
    } finally {
      busy.current = false;
    }
  }

  return (
    <section
      className="mt-3 rounded-lg border border-current/20 p-3"
    >

      <button
        type="button"
        className="text-sm font-semibold"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        Supplier communication {expanded ? "-" : "+"}
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">

          <p className="text-xs opacity-75">
            Discuss product specifications,
            pricing, availability and delivery
            directly against this request.
          </p>

          <button
            type="button"
            disabled={thread.isFetching}
            onClick={() => void thread.refetch()}
            className="rounded border border-current/20 px-3 py-1 text-xs"
          >
            Refresh conversation
          </button>

          {thread.isLoading && (
            <p className="text-sm">
              Loading conversation...
            </p>
          )}

          {thread.isError && (
            <p role="alert" className="text-sm">
              Conversation could not be loaded.
            </p>
          )}

          {thread.isSuccess &&
            thread.data.length === 0 && (
              <p className="text-sm opacity-60">
                No messages yet.
              </p>
          )}

          {thread.isSuccess && (
            <div className="max-h-96 space-y-2 overflow-y-auto">

              {thread.data.map((row) => (
                <article
                  key={row.id}
                  className="rounded-lg border border-current/15 p-3"
                >

                  <div className="flex flex-wrap justify-between gap-2 text-xs opacity-70">

                    <span className="font-semibold">
                      {row.sender_type === "supplier"
                        ? "Supplier"
                        : "Procurement"}
                    </span>

                    <span>
                      {new Date(
                        row.created_at
                      ).toLocaleString()}
                    </span>

                  </div>

                  <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                    {row.message_body}
                  </p>

                </article>
              ))}

            </div>
          )}

          {thread.isSuccess &&
            thread.data.length >= 200 && (
              <p className="text-xs opacity-70">
                Showing the most recent 200 messages.
              </p>
          )}

          <label className="block text-sm">

            Write a message

            <textarea
              rows={3}
              maxLength={4000}
              disabled={
                send.isPending ||
                unresolved
              }
              value={body}
              onChange={(e) =>
                setBody(e.target.value)
              }
              className="mt-1 w-full rounded-lg border border-current/20 bg-transparent p-2"
            />

          </label>

          <button
            type="button"
            disabled={
              send.isPending ||
              !body.trim() ||
              !thread.isSuccess
            }
            onClick={() => void submit()}
            className="rounded-lg border border-current/30 px-4 py-2 text-sm font-semibold disabled:opacity-40"
          >
            {send.isPending
              ? "Sending..."
              : unresolved
                ? "Retry same message"
                : "Send message"}
          </button>

          {message && (
            <p
              role="status"
              className="text-sm"
            >
              {message}
            </p>
          )}

          <p className="text-xs opacity-60">
            Messages do not approve purchase orders,
            change agreed prices or create financial
            transactions.
          </p>

        </div>
      )}

    </section>
  );
}