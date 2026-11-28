import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  classifySupplierAvailability,
  prepareSupplierAvailabilityLine,
} from "@/lib/supplier-availability";

import {
  useSubmitSupplierAvailability,
} from "@/lib/supplier-availability-api";

type RequestedLine = {
  id: string;
  description: string;
  quantity: number;
  unit: string;
};

type Rfq = {
  id: string;
  rfq_number: string;
  closes_at: string | null;
  lines: RequestedLine[];
  response_state?: string;
  response: {
    status: string;
  } | null;
};

type Draft = {
  available: string;
  lead: string;
  alternative: string;
  notes: string;
};

const emptyDraft: Draft = {
  available: "",
  lead: "",
  alternative: "",
  notes: "",
};

export function SupplierAvailabilityForm({
  branchId,
  relationshipId,
  rfq,
}: {
  branchId: string;
  relationshipId: string;
  rfq: Rfq;
}) {
  const qc = useQueryClient();
  const submit = useSubmitSupplierAvailability();

  const [expanded, setExpanded] = useState(false);

  const [drafts, setDrafts] = useState<
    Record<string, Draft>
  >({});

  const [notes, setNotes] = useState("");

  const [message, setMessage] = useState("");

  const [confirmed, setConfirmed] = useState(false);

  const [unresolved, setUnresolved] = useState(false);

  const sending = useRef(false);

  const attempt = useRef<{
    fingerprint: string;
    id: string;
  } | null>(null);

  const closed =
    Boolean(
      rfq.closes_at &&
      rfq.closes_at.slice(0, 10) < new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
    ) ||
    (
      Boolean(rfq.response_state) &&
      rfq.response_state !== "accepting-quotations"
    );

  const selected = rfq.response?.status === "selected";

  const locked =
    closed ||
    selected ||
    submit.isPending ||
    unresolved;

  function update(
    id: string,
    field: keyof Draft,
    value: string
  ) {
    setDrafts((previous) => ({
      ...previous,
      [id]: {
        ...(previous[id] ?? emptyDraft),
        [field]: value,
      },
    }));

    setConfirmed(false);
    setMessage("");
  }

  function fillAvailability(mode: "full" | "none") {
    const next: Record<string, Draft> = {};

    for (const line of rfq.lines) {
      next[line.id] = {
        ...(drafts[line.id] ?? emptyDraft),
        available:
          mode === "full"
            ? String(line.quantity)
            : "0",
      };
    }

    setDrafts(next);
    setConfirmed(false);
    setMessage("");
  }

  async function send() {
    if (sending.current || closed || selected) return;

    sending.current = true;

    setMessage("");

    try {
      const lines = rfq.lines.map((line) => {
        const draft = drafts[line.id] ?? emptyDraft;

        return prepareSupplierAvailabilityLine({
          requestLineId: line.id,
          requested: Number(line.quantity),
          available: draft.available,
          leadTimeDays: draft.lead,
          alternative: draft.alternative,
          notes: draft.notes,
        });
      });

      if (notes.trim().length > 4000) {
        throw new Error("Response notes are too long.");
      }

      const fingerprint = JSON.stringify({
        branchId,
        relationshipId,
        rfqId: rfq.id,
        lines,
        notes: notes.trim(),
      });

      if (
        attempt.current &&
        attempt.current.fingerprint !== fingerprint
      ) {
        throw new Error(
          "Retry the existing response before changing its details."
        );
      }

      if (!attempt.current) {
        attempt.current = {
          fingerprint,
          id: crypto.randomUUID(),
        };
      }

      setUnresolved(true);

      const result = await submit.mutateAsync({
        branchId,
        relationshipId,
        rfqId: rfq.id,
        attemptId: attempt.current.id,
        lines,
        notes: notes.trim(),
      });

      attempt.current = null;

      setUnresolved(false);
      setConfirmed(true);

      setMessage(
        `Availability response confirmed. Reference: ${result.responseId}`
      );

      await qc.invalidateQueries({
        queryKey: [
          "partner-supplier-rfqs",
          branchId,
          relationshipId,
        ],
      });

    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : typeof error === "object" &&
              error !== null &&
              "message" in error
            ? String(error.message)
            : "Submission could not be confirmed."
      );
    } finally {
      sending.current = false;
    }
  }

  return (
    <section className="mt-3 rounded-xl border border-white/20 bg-white/5 p-4 text-white">

      <button
        type="button"
        className="w-full text-left text-sm font-semibold"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        Product availability and alternatives
        <span className="ml-2 text-white/60">
          {expanded ? "-" : "+"}
        </span>
      </button>

      {expanded && (
        <div className="mt-4 space-y-4">

          <p className="text-sm text-white/75">
            Tell Procurement what you can supply.
            A partial availability response is not
            an accepted quotation or purchase order.
          </p>

          {(closed || selected) && (
            <p role="status" className="text-sm text-amber-200">
              This request is no longer accepting
              availability changes.
            </p>
          )}

          <div className="flex flex-wrap gap-2">

            <button
              type="button"
              disabled={locked}
              onClick={() => fillAvailability("full")}
              className="rounded-lg border border-white/20 px-3 py-2 text-xs disabled:opacity-40"
            >
              All items available
            </button>

            <button
              type="button"
              disabled={locked}
              onClick={() => fillAvailability("none")}
              className="rounded-lg border border-white/20 px-3 py-2 text-xs disabled:opacity-40"
            >
              All items unavailable
            </button>

          </div>

          {rfq.lines.map((line) => {
            const draft = drafts[line.id] ?? emptyDraft;

            let state = "Not answered";

            if (draft.available.trim()) {
              try {
                state = classifySupplierAvailability(
                  Number(line.quantity),
                  Number(draft.available)
                );
              } catch {
                state = "Invalid quantity";
              }
            }

            return (
              <div
                key={line.id}
                className="rounded-lg border border-white/15 p-3"
              >

                <div className="flex flex-wrap items-center justify-between gap-2">

                  <p className="text-sm font-medium">
                    {line.description}
                  </p>

                  <span className="text-xs text-white/70">
                    {state}
                  </span>

                </div>

                <p className="mb-3 text-xs text-white/60">
                  Requested: {line.quantity} {line.unit}
                </p>

                <div className="grid gap-3 sm:grid-cols-2">

                  <label className="text-xs">
                    Available quantity

                    <input
                      type="number"
                      min="0"
                      max={line.quantity}
                      step="any"
                      disabled={locked}
                      value={draft.available}
                      onChange={(e) =>
                        update(
                          line.id,
                          "available",
                          e.target.value
                        )
                      }
                      className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2"
                    />
                  </label>

                  <label className="text-xs">
                    Delivery lead time (days)

                    <input
                      type="number"
                      min="0"
                      max="3650"
                      step="1"
                      disabled={locked}
                      value={draft.lead}
                      onChange={(e) =>
                        update(
                          line.id,
                          "lead",
                          e.target.value
                        )
                      }
                      className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2"
                    />
                  </label>

                  <label className="text-xs">
                    Alternative product

                    <input
                      disabled={locked}
                      maxLength={1000}
                      value={draft.alternative}
                      onChange={(e) =>
                        update(
                          line.id,
                          "alternative",
                          e.target.value
                        )
                      }
                      placeholder="Optional"
                      className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2"
                    />
                  </label>

                  <label className="text-xs">
                    Item remarks

                    <input
                      disabled={locked}
                      maxLength={1000}
                      value={draft.notes}
                      onChange={(e) =>
                        update(
                          line.id,
                          "notes",
                          e.target.value
                        )
                      }
                      placeholder="Optional"
                      className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2"
                    />
                  </label>

                </div>

              </div>
            );
          })}

          <label className="block text-xs">
            Additional response notes

            <textarea
              rows={3}
              maxLength={4000}
              disabled={locked}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setConfirmed(false);
              }}
              className="mt-1 w-full rounded-lg border border-white/20 bg-white/10 p-2"
            />
          </label>

          <p className="text-xs text-amber-200">
            Reporting insufficient availability can
            supersede a previous unselected full quotation.
          </p>

          {unresolved && (
            <p className="text-xs text-amber-200">
              Submission is not yet confirmed.
              Retry the same response without changing
              its details.
            </p>
          )}

          <button
            type="button"
            disabled={
              closed ||
              selected ||
              submit.isPending ||
              confirmed ||
              rfq.lines.length === 0
            }
            onClick={() => void send()}
            className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black disabled:opacity-40"
          >
            {submit.isPending
              ? "Submitting..."
              : unresolved
                ? "Retry availability response"
                : confirmed
                  ? "Response submitted"
                  : "Submit availability to Procurement"}
          </button>

          {message && (
            <p
              role={confirmed ? "status" : "alert"}
              className={
                confirmed
                  ? "break-all text-sm text-green-200"
                  : "text-sm text-amber-200"
              }
            >
              {message}
            </p>
          )}

        </div>
      )}

    </section>
  );
}