import { requireBlindReceiptResult } from "@/lib/supply-command-result";
import { invalidateSupplyViews } from "@/lib/supply-view-refresh";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { resolveApprovedCountOwnership } from "@/lib/supply-release-compat";

const db = supabase as any;

export function ApprovedReceivingPosting() {
  const queryClient = useQueryClient();
  const { can, user, organizationId, permissionsLoaded } = useAuth();
  const { branchId, filterKey } = useActivePropertyFilter();
  const [posted, setPosted] = useState<{
    grnId: string;
    orderId: string;
    orderNumber: string;
    propertyId: string;
  } | null>(null);
  const canPost = permissionsLoaded && can("procurement", "receiving.manage");
  const approvedQueue = useQuery({
    queryKey: ["procurement", "approved-blind-receiving", organizationId, user?.id, filterKey],
    enabled: canPost,
    queryFn: async (): Promise<
      Array<{
        count_id: string;
        purchase_order_id: string;
        branch_id: string;
        order_number: string;
        delivery_note: string;
        submitted_at: string;
        reviewed_at: string;
        review_notes: string | null;
        posting_block_reason?: string | null;
        status: string;
        line_count: number;
      }>
    > => {
      const { data, error } = await guardedRpc(db, "neo_blind_receiving_approved_queue", {});

      if (error) throw new Error(error.message);
      const rows = await resolveApprovedCountOwnership(data, async (ids) => {
        if (!organizationId) throw new Error("Organization required");
        const { data: saved, error: lookupError } = await db.from("neo_blind_receiving_counts")
          .select("id,branch_id,purchase_order_id").eq("organization_id", organizationId).in("id", ids);
        if (lookupError) throw new Error(lookupError.message);
        return saved ?? [];
      });
      return rows.filter((row) => !branchId || row["branch_id"] === branchId) as Array<{
        count_id: string; purchase_order_id: string; branch_id: string; order_number: string;
        delivery_note: string; submitted_at: string; reviewed_at: string; review_notes: string | null;
        posting_block_reason?: string | null; status: string; line_count: number;
      }>;
    },
  });

  const postApproved = useMutation({
    mutationFn: async (count: NonNullable<typeof approvedQueue.data>[number]) => {
      const { data, error } = await guardedRpc(db, "neo_post_approved_blind_receiving", {
        _count_id: count.count_id,
      });

      if (error) throw new Error(error.message);
      return requireBlindReceiptResult(data, count.count_id);
    },

    onSuccess: async (result, count) => {
      setPosted({
        grnId: result["grn_id"] as string,
        orderId: count.purchase_order_id,
        orderNumber: count.order_number,
        propertyId: count.branch_id,
      });
      await invalidateSupplyViews(queryClient);
      const lifecycle = result["lifecycle_result"] as Record<string, unknown> | undefined;
      const posting = lifecycle?.["posting"] as Record<string, unknown> | undefined;
      if (posting?.["status"] === "pending-finance")
        toast.warning("Goods received into stock. Finance accrual still needs attention.");
      else
        toast.success(
          result["replayed"] === true
            ? "This approved count was already posted. Showing the saved GRN."
            : "Approved GRN posted successfully.",
        );
    },

    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  function postApprovedCount(count: NonNullable<typeof approvedQueue.data>[number]) {
    const confirmed = window.confirm(
      `Post the approved delivery for ${count.order_number} into inventory? ` +
        "This will create a GRN and update stock balances.",
    );

    if (!confirmed) return;

    postApproved.mutate(count);
  }

  if (!canPost) return null;
  return (
    <SectionCard
      title="Approved Counts Awaiting GRN"
      description="These counts have independent approval but have not yet entered stock. A receiving manager can post them here to create the linked GRN."
    >
      {posted && (!branchId || posted.propertyId === branchId) && (
        <div className="mb-4 space-y-3 rounded-lg border p-4" role="status">
          <p className="font-medium">Saved GRN for {posted.orderNumber}</p>
          <DocumentPrintButton type="goods_receipt" id={posted.grnId} label="Print GRN" />
          {posted.orderId && (
            <Link to="/lpos/$id" params={{ id: posted.orderId }} className="block text-sm underline">
              Open purchase and document history
            </Link>
          )}
          <p className="text-xs text-muted-foreground">
            Reprints use this saved receipt. The GRN remains in the purchase history after leaving this screen.
          </p>
        </div>
      )}
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
        <p className="text-sm text-muted-foreground">Loading approved counts...</p>
      )}

      {approvedQueue.isError && (
        <p className="text-sm text-destructive">
          Unable to load approved counts:{" "}
          {approvedQueue.error instanceof Error ? approvedQueue.error.message : "Unknown error"}
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
              <p className="font-semibold">{approved.order_number}</p>

              <p className="text-sm text-muted-foreground">
                Supplier delivery note: {approved.delivery_note}
              </p>

              <p className="text-xs text-muted-foreground">
                {approved.line_count} item(s) · Approved{" "}
                {new Date(approved.reviewed_at).toLocaleString()}
              </p>

              {/* neoReceivingPostingEligibilityV1 */}
              {approved.posting_block_reason && (
                <p className="text-sm text-destructive" role="status">
                  {approved.posting_block_reason}
                </p>
              )}

              {approved.review_notes && (
                <p className="text-xs text-muted-foreground">Review: {approved.review_notes}</p>
              )}
            </div>

            <Button
              disabled={postApproved.isPending || !!approved.posting_block_reason}
              onClick={() => postApprovedCount(approved)}
            >
              {postApproved.isPending ? "Posting..." : "Post Approved GRN"}
            </Button>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Quantities and purchase prices are retrieved from the approved database records. Stock
        posting remains subject to server-side authorization and outstanding-quantity checks.
      </p>
    </SectionCard>
  );
}
