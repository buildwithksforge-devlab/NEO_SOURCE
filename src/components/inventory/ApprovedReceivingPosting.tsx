import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useAuth } from "@/lib/auth";
import { SectionCard } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";

const db = supabase as any;

export function ApprovedReceivingPosting() {
  const queryClient = useQueryClient();
  const { can, user, organizationId, permissionsLoaded } = useAuth();
  const canPost =
    permissionsLoaded && can("procurement", "receiving.manage");
  const approvedQueue = useQuery({
    queryKey: ["procurement", "approved-blind-receiving", organizationId, user?.id],
    enabled: canPost,
    queryFn: async (): Promise<Array<{
      count_id: string;
      order_number: string;
      delivery_note: string;
      submitted_at: string;
      reviewed_at: string;
      review_notes: string | null;
      posting_block_reason?: string | null;
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


  if (!canPost) return null;
  return (
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

                {/* neoReceivingPostingEligibilityV1 */}
                {approved.posting_block_reason && (
                  <p className="text-sm text-destructive" role="status">
                    {approved.posting_block_reason}
                  </p>
                )}

                {approved.review_notes && (
                  <p className="text-xs text-muted-foreground">
                    Review: {approved.review_notes}
                  </p>
                )}
              </div>

              <Button
                disabled={postApproved.isPending || !!approved.posting_block_reason}
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
  );
}
