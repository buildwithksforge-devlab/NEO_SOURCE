import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { OpsGuard } from "@/components/operations/OpsShared";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

const db = supabase as any;

type ReviewLine = {
  count_line_id: string;
  order_line_id: string;
  item_name?: string;
  unit?: string;
  ordered_quantity: number;
  previously_received: number;
  cancelled_quantity: number;
  outstanding_quantity: number;
  physically_delivered: number;
  rejected_quantity: number;
  accepted_quantity: number;
  difference: number;
  reconciliation_result: string;
  rejection_reason: string | null;
  batch_number: string | null;
  expiry_date: string | null;
};

type ReviewCount = {
  count_id: string;
  purchase_order_id: string;
  order_number: string;
  branch_id: string;
  delivery_note: string;
  submitted_by: string;
  submitted_at: string;
  status: string;
  remarks: string | null;
  lines: ReviewLine[];
};

export const Route = createFileRoute(
  "/_shell/procurement/reconciliation"
)({
  component: GuardedPage,
});

function formatQuantity(value: number) {
  return Number(value ?? 0).toLocaleString(undefined, {
    maximumFractionDigits: 3,
  });
}

function Page() {
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});

  const queue = useQuery({
    queryKey: ["procurement", "blind-reconciliation"],
    queryFn: async (): Promise<ReviewCount[]> => {
      const { data, error } = await guardedRpc(
        db,
        "neo_blind_receiving_review_queue",
        {}
      );

      if (error) throw new Error(error.message);

      return Array.isArray(data) ? (data as ReviewCount[]) : [];
    },
  });

  const decide = useMutation({
    mutationFn: async (payload: {
      countId: string;
      decision: "approved" | "rejected";
      notes: string;
    }) => {
      const { data, error } = await guardedRpc(
        db,
        "neo_blind_receiving_decide",
        {
          _count_id: payload.countId,
          _decision: payload.decision,
          _notes: payload.notes,
        }
      );

      if (error) throw new Error(error.message);

      return data;
    },

    onSuccess: () => {
      toast.success("Receiving review decision recorded.");

      void queryClient.invalidateQueries({
        queryKey: ["procurement"],
      });
    },

    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  function submitDecision(
    countId: string,
    decision: "approved" | "rejected"
  ) {
    const reason = notes[countId]?.trim() ?? "";

    if (!reason) {
      toast.error("Enter a reason for the review decision.");
      return;
    }

    if (!window.confirm(`Confirm ${decision} decision?`)) {
      return;
    }

    decide.mutate({
      countId,
      decision,
      notes: reason,
    });
  }

  const approvedQueue = useQuery({
    queryKey: ["procurement", "approved-blind-receiving"],
    queryFn: async (): Promise<Array<{
      count_id: string;
      order_number: string;
      delivery_note: string;
      submitted_at: string;
      reviewed_at: string;
      review_notes: string | null;
      status: string;
      line_count: number;
    }>> => {
      const { data, error } = await guardedRpc(
        db,
        "neo_blind_receiving_approved_queue",
        {}
      );

      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data : [];
    },
  });

  const postApproved = useMutation({
    mutationFn: async (countId: string) => {
      const { data, error } = await guardedRpc(
        db,
        "neo_post_approved_blind_receiving",
        { _count_id: countId }
      );

      if (error) throw new Error(error.message);
      return data;
    },

    onSuccess: () => {
      toast.success("Approved GRN posted successfully.");

      void queryClient.invalidateQueries({
        queryKey: ["procurement"],
      });

      void queryClient.invalidateQueries({
        queryKey: ["inventory"],
      });
    },

    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  function postApprovedCount(countId: string, orderNumber: string) {
    const confirmed = window.confirm(
      `Post the approved delivery for ${orderNumber} into inventory? ` +
      "This will create a GRN and update stock balances."
    );

    if (!confirmed) return;

    postApproved.mutate(countId);
  }

  const counts = queue.data ?? [];

  const totalLines = counts.reduce(
    (sum, count) => sum + count.lines.length,
    0
  );

  const excessLines = counts.reduce(
    (sum, count) =>
      sum +
      count.lines.filter(
        (line) => line.reconciliation_result === "excess"
      ).length,
    0
  );

  const partialLines = counts.reduce(
    (sum, count) =>
      sum +
      count.lines.filter(
        (line) => line.reconciliation_result === "partial_delivery"
      ).length,
    0
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Procurement"
        title="Blind Receiving Reconciliation"
        description="Independent comparison of physical supplier deliveries against approved purchase orders."
      />

      <div className="grid gap-3 sm:grid-cols-4">
        {[
          ["Awaiting review", counts.length],
          ["Counted items", totalLines],
          ["Partial deliveries", partialLines],
          ["Excess deliveries", excessLines],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl border p-5">
            <p className="text-2xl font-semibold">{value}</p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>

      <SectionCard
        title="Independent receiving review"
        description="Review and authorize the original physical counts. Approval does not post stock."
      >
        <div className="mb-4 flex justify-end">
          <Button
            variant="outline"
            disabled={queue.isFetching}
            onClick={() => void queue.refetch()}
          >
            {queue.isFetching ? "Refreshing..." : "Refresh queue"}
          </Button>
        </div>

        {queue.isLoading && (
          <p className="text-sm text-muted-foreground">
            Loading submitted receiving counts...
          </p>
        )}

        {queue.isError && (
          <p className="text-sm text-destructive">
            Reconciliation could not be loaded:{" "}
            {queue.error instanceof Error
              ? queue.error.message
              : "Unknown error"}
          </p>
        )}

        {!queue.isLoading && !queue.isError && counts.length === 0 && (
          <p className="rounded-lg border p-6 text-sm text-muted-foreground">
            No submitted blind receiving counts require your review.
          </p>
        )}

        <div className="space-y-5">
          {counts.map((count) => {
            const hasExcess = count.lines.some(
              (line) => line.reconciliation_result === "excess"
            );

            return (
              <div
                key={count.count_id}
                className="space-y-4 rounded-xl border p-5"
              >
                <div className="flex flex-wrap justify-between gap-4">
                  <div>
                    <h3 className="font-semibold">
                      {count.order_number}
                    </h3>

                    <p className="text-sm text-muted-foreground">
                      Supplier delivery note: {count.delivery_note}
                    </p>

                    <p className="text-xs text-muted-foreground">
                      Submitted:{" "}
                      {new Date(count.submitted_at).toLocaleString()}
                    </p>
                  </div>

                  <span className="h-fit rounded-full border px-3 py-1 text-xs">
                    {count.status}
                  </span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-left text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="p-3">PO item</th>
                        <th className="p-3 text-right">Ordered</th>
                        <th className="p-3 text-right">Previously received</th>
                        <th className="p-3 text-right">Outstanding</th>
                        <th className="p-3 text-right">Delivered</th>
                        <th className="p-3 text-right">Rejected</th>
                        <th className="p-3 text-right">Accepted</th>
                        <th className="p-3 text-right">Variance</th>
                        <th className="p-3">Batch</th>
                        <th className="p-3">Expiry</th>
                        <th className="p-3">Rejection reason</th>
                        <th className="p-3">Result</th>
                      </tr>
                    </thead>

                    <tbody>
                      {count.lines.map((line) => (
                        <tr
                          key={line.count_line_id}
                          className="border-b last:border-0"
                        >
                          <td className="p-3">
                            <p className="font-medium">
                              {line.item_name || "Unidentified item"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {line.unit || "Unit not specified"}
                            </p>
                          </td>

                          <td className="p-3 text-right">
                            {formatQuantity(line.ordered_quantity)}
                          </td>

                          <td className="p-3 text-right">
                            {formatQuantity(line.previously_received)}
                          </td>

                          <td className="p-3 text-right">
                            {formatQuantity(line.outstanding_quantity)}
                          </td>

                          <td className="p-3 text-right">
                            {formatQuantity(line.physically_delivered)}
                          </td>

                          <td className="p-3 text-right">
                            {formatQuantity(line.rejected_quantity)}
                          </td>

                          <td className="p-3 text-right">
                            {formatQuantity(line.accepted_quantity)}
                          </td>

                          <td className="p-3 text-right">
                            {formatQuantity(line.difference)}
                          </td>

                          <td className="p-3">
                            {line.batch_number || "Not entered"}
                          </td>
                          <td className="p-3 whitespace-nowrap">
                            {line.expiry_date || "Not entered"}
                          </td>
                          <td className="p-3">
                            {line.rejection_reason || "Not entered"}
                          </td>

                          <td className="p-3">
                            <span
                              className={
                                line.reconciliation_result === "excess"
                                  ? "font-semibold text-destructive"
                                  : line.reconciliation_result ===
                                      "partial_delivery"
                                    ? "font-medium text-on-tint-warning"
                                    : "font-medium text-on-tint-success"
                              }
                            >
                              {line.reconciliation_result.replaceAll("_", " ")}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-3 rounded-lg border p-4">
                  <p className="text-sm font-semibold">
                    Independent review decision
                  </p>

                  <Textarea
                    value={notes[count.count_id] ?? ""}
                    onChange={(event) =>
                      setNotes((previous) => ({
                        ...previous,
                        [count.count_id]: event.target.value,
                      }))
                    }
                    placeholder="Record review findings and justification..."
                  />

                  <div className="flex flex-wrap justify-end gap-3">
                    <Button
                      variant="destructive"
                      disabled={decide.isPending}
                      onClick={() =>
                        submitDecision(count.count_id, "rejected")
                      }
                    >
                      Reject Count
                    </Button>

                    <Button
                      disabled={decide.isPending || hasExcess}
                      onClick={() =>
                        submitDecision(count.count_id, "approved")
                      }
                    >
                      Approve Count
                    </Button>
                  </div>

                  {hasExcess && (
                    <p className="text-xs text-destructive">
                      Approval is blocked because this delivery exceeds
                      the outstanding purchase-order quantity.
                    </p>
                  )}

                  <p className="text-xs text-muted-foreground">
                    The physical count remains unchanged. Approval
                    does not create a GRN or post inventory.
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard
        title="Approved Counts Awaiting Posting"
        description="Only independently approved physical counts appear here. Inventory posting is a separate authorized action."
      >
        <div className="mb-4 flex justify-end">
          <Button
            variant="outline"
            disabled={approvedQueue.isFetching}
            onClick={() => void approvedQueue.refetch()}
          >
            {approvedQueue.isFetching ? "Refreshing..." : "Refresh approved counts"}
          </Button>
        </div>

        {approvedQueue.isLoading && (
          <p className="text-sm text-muted-foreground">
            Loading approved counts...
          </p>
        )}

        {approvedQueue.isError && (
          <p className="text-sm text-destructive">
            Unable to load approved counts:{" "}
            {approvedQueue.error instanceof Error
              ? approvedQueue.error.message
              : "Unknown error"}
          </p>
        )}

        {!approvedQueue.isLoading &&
          !approvedQueue.isError &&
          (approvedQueue.data ?? []).length === 0 && (
            <p className="rounded-lg border p-6 text-sm text-muted-foreground">
              No approved receiving counts are awaiting stock posting.
            </p>
          )}

        <div className="space-y-3">
          {(approvedQueue.data ?? []).map((approved) => (
            <div
              key={approved.count_id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
            >
              <div className="space-y-1">
                <p className="font-semibold">
                  {approved.order_number}
                </p>

                <p className="text-sm text-muted-foreground">
                  Supplier delivery note: {approved.delivery_note}
                </p>

                <p className="text-xs text-muted-foreground">
                  {approved.line_count} item(s) · Approved{" "}
                  {new Date(approved.reviewed_at).toLocaleString()}
                </p>

                {approved.review_notes && (
                  <p className="text-xs text-muted-foreground">
                    Review: {approved.review_notes}
                  </p>
                )}
              </div>

              <Button
                disabled={postApproved.isPending}
                onClick={() =>
                  postApprovedCount(
                    approved.count_id,
                    approved.order_number
                  )
                }
              >
                {postApproved.isPending
                  ? "Posting..."
                  : "Post Approved GRN"}
              </Button>
            </div>
          ))}
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          Quantities and purchase prices are retrieved from the approved
          database records. Stock posting remains subject to server-side
          authorization and outstanding-quantity checks.
        </p>
      </SectionCard>
    </div>
  );
}

function GuardedPage() {
  return (
    <OpsGuard path="/procurement/orders">
      <Page />
    </OpsGuard>
  );
}
