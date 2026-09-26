import { createFileRoute } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, PosGuard, QueryState } from "@/components/pos/PosShared";
import { useAuth } from "@/lib/auth";
import { money, titleCase } from "@/lib/pos";
import { resolvePosApprovalGates } from "@/lib/pos-approvals-authority";

import { useDecideRefund, useDecideVoid, useRefundRequests, useVoidRequests } from "@/lib/pos-data";

export const Route = createFileRoute("/_shell/pos/approvals")({
  head: () => ({
    meta: [
      { title: "POS Approvals — NEØ" },
      {
        name: "description",
        content:
          "Manager review of void and refund requests, with reasons, requesters and decisions on record.",
      },
      { property: "og:title", content: "POS Approvals — NEØ" },
      {
        property: "og:description",
        content:
          "Manager review of void and refund requests, with reasons, requesters and decisions on record.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="approvals.approve" path="/pos/approvals">
      <ApprovalsPage />
    </PosGuard>
  ),
});

function tone(status: string) {
  if (status === "pending") return "warning" as const;
  if (status === "rejected") return "destructive" as const;
  return "success" as const;
}

function ApprovalsPage() {
  const { can } = useAuth();
  const voids = useVoidRequests();
  const refunds = useRefundRequests();
  const decideVoid = useDecideVoid();
  const decideRefund = useDecideRefund();
  // One aligned contract: `pos.approvals.decide` is the POS decision authority,
  // aliased onto catalogued `restaurant.approvals.approve`, so route guard,
  // buttons, RPC and RLS all answer from the same permission. The mapping is
  // validated at import time, so a missing capability fails fast instead of
  // rendering a decision nobody may take.
  const { canDecideVoid, canDecideRefund } = resolvePosApprovalGates(can);


  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title="Voids, Refunds & Discount Approvals"
        description="Nothing is voided or refunded on request alone. A second, authorised person must decide, and the decision is permanent."
      />

      <SectionCard
        title="Void requests"
        description="Items already sent to a station require approval to remove."
      >
        <QueryState
          isLoading={voids.isLoading}
          error={voids.error}
          isEmpty={(voids.data ?? []).length === 0}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title="No void requests"
              description="Requests raised on the floor appear here."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(voids.data ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">
                      {r.pos_orders?.order_number ?? "—"}
                    </TableCell>
                    <TableCell>
                      {r.pos_order_items?.item_name ?? titleCase(r.request_kind)}
                    </TableCell>
                    <TableCell className="max-w-64 truncate">{r.reason}</TableCell>
                    <TableCell>{money(r.amount)}</TableCell>
                    <TableCell>
                      <StatusPill tone={tone(r.status)}>{titleCase(r.status)}</StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.status === "pending" && canDecideVoid ? (
                        <span className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            onClick={() => decideVoid.mutate({ id: r.id, approve: true })}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => decideVoid.mutate({ id: r.id, approve: false })}
                          >
                            Reject
                          </Button>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {r.decided_at
                            ? new Date(r.decided_at).toLocaleString()
                            : "Awaiting a manager"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <SectionCard
        className="mt-6"
        title="Refund requests"
        description="Refunds can never exceed the original payment."
      >
        <QueryState
          isLoading={refunds.isLoading}
          error={refunds.error}
          isEmpty={(refunds.data ?? []).length === 0}
          empty={
            <EmptyState
              title="No refund requests"
              description="Refunds requested against confirmed payments appear here."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Original payment</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Decision</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(refunds.data ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">
                      {r.pos_orders?.order_number ?? "—"}
                    </TableCell>
                    <TableCell>
                      {r.pos_payments
                        ? `${titleCase(r.pos_payments.method)} · ${money(r.pos_payments.amount)}`
                        : "—"}
                    </TableCell>
                    <TableCell className="max-w-64 truncate">{r.reason}</TableCell>
                    <TableCell>{money(r.amount)}</TableCell>
                    <TableCell>
                      <StatusPill tone={tone(r.status)}>{titleCase(r.status)}</StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      {r.status === "pending" && canDecideRefund ? (
                        <span className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            onClick={() => decideRefund.mutate({ id: r.id, approve: true })}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => decideRefund.mutate({ id: r.id, approve: false })}
                          >
                            Reject
                          </Button>
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {r.decided_at
                            ? new Date(r.decided_at).toLocaleString()
                            : "Awaiting a manager"}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>
    </div>
  );
}
