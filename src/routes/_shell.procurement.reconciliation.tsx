import { ApprovedReceivingPosting } from "@/components/inventory/ApprovedReceivingPosting";
import { requireReceivingReviewResult } from "@/lib/supply-command-result";
import { invalidateSupplyViews } from "@/lib/supply-view-refresh";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
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
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";

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
  submitted_by_current_user?: boolean;
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
  const { organizationId, user, permissionsLoaded } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();
  const queryClient = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [recentlyPosted, setRecentlyPosted] = useState<{
    grnId: string;
    orderNumber: string;
  } | null>(null);

  const queue = useQuery({
    queryKey: ["procurement", "blind-reconciliation", organizationId, user?.id, filterKey],
    enabled: Boolean(organizationId && user && permissionsLoaded),
    queryFn: async (): Promise<ReviewCount[]> => {
      const { data, error } = await guardedRpc(
        db,
        "neo_blind_receiving_review_queue",
        {}
      );

      if (error) throw new Error(error.message);

      return Array.isArray(data)
        ? (data as ReviewCount[]).filter((row) => !branchId || row.branch_id === branchId)
        : [];
    },
  });

  const decide = useMutation({
    mutationFn: async (payload: {
      countId: string;
      decision: "approved" | "rejected";
      notes: string;
      orderNumber: string;
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

      return requireReceivingReviewResult(data, payload.countId, payload.decision);
    },

    onSuccess: async (result, payload) => {
      if (payload.decision === "approved" && result && typeof result === "object") {
        const grnId = (result as Record<string, unknown>)["grn_id"];
        if (typeof grnId === "string" && grnId) {
          setRecentlyPosted({ grnId, orderNumber: payload.orderNumber });
          const postingResult = result["posting_result"] as Record<string, unknown> | undefined;
          const lifecycle = postingResult?.["lifecycle_result"] as Record<string, unknown> | undefined;
          const posting = lifecycle?.["posting"] as Record<string, unknown> | undefined;
          if (posting?.["status"] === "pending-finance")
            toast.warning("GRN created and stock received. Finance accrual needs attention.");
          else toast.success("Receiving approved, stock updated, and GRN generated.");
        } else {
          toast.info("Count approved. A receiving manager must now select Post Approved GRN below; stock has not moved yet.");
        }
      } else {
        toast.success("Receiving review decision recorded.");
      }

      await invalidateSupplyViews(queryClient);
    },

    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  function submitDecision(count: ReviewCount, decision: "approved" | "rejected") {
    const reason = notes[count.count_id]?.trim() ?? "";

    if (!reason) {
      toast.error("Enter a reason for the review decision.");
      return;
    }

    if (!window.confirm(`Confirm ${decision} decision?`)) {
      return;
    }

    decide.mutate({
      countId: count.count_id,
      decision,
      notes: reason,
      orderNumber: count.order_number,
    });
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
        description="Review the original physical counts. Reviewers with receiving posting authority create the GRN on approval. Otherwise, a receiving manager posts the approved count in the section below."
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
            const submittedByCurrentUser = count.submitted_by_current_user === true;
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
                    {submittedByCurrentUser ? (
                      <p className="mt-2 text-sm font-medium text-on-tint-warning" role="status">
                        Submitted by you. Another authorized reviewer must decide this count.
                      </p>
                    ) : null}
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

                {!submittedByCurrentUser ? (
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
                        onClick={() => submitDecision(count, "rejected")}
                      >
                        Reject Count
                      </Button>

                      <Button
                        disabled={decide.isPending || hasExcess}
                        onClick={() => submitDecision(count, "approved")}
                      >
                        Approve & Post GRN
                      </Button>
                    </div>

                    {hasExcess && (
                      <p className="text-xs text-destructive">
                        Approval is blocked because this delivery exceeds the outstanding
                        purchase-order quantity.
                      </p>
                    )}

                    <p className="text-xs text-muted-foreground">
                      The original physical count stays immutable. Rejection preserves the count
                      and review reason; approval posts stock once through the linked GRN.
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </SectionCard>

      {recentlyPosted ? (
        <SectionCard
          title="Receiving posted"
          description={`GRN generated for LPO ${recentlyPosted.orderNumber}. The document remains available from the LPO record.`}
        >
          <DocumentPrintButton
            type="goods_receipt"
            id={recentlyPosted.grnId}
            label={`Download GRN - ${recentlyPosted.orderNumber}`}
            variant="secondary"
          />
        </SectionCard>
      ) : null}

      <ApprovedReceivingPosting />
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
