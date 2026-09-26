import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ReceiptText } from "lucide-react";
import { toast } from "sonner";
import { PageHeader, SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { formatDate, formatDateTime, money, titleCase } from "@/lib/pms";
import { useReservation, useReservationFolios, useReservationHistory } from "@/lib/pms-data";
import {
  EmptyState,
  FolioStatusBadge,
  PmsGuard,
  QueryState,
  ReservationStatusBadge,
} from "@/components/pms/PmsShared";
import {
  AssignRoomDialog,
  CheckInDialog,
  CheckOutDialog,
  PostChargeDialog,
  RecordPaymentDialog,
} from "@/components/pms/ReservationActions";
import { MpesaPromptDialog } from "@/components/payments/MpesaPromptDialog";
import { DepositPanel } from "@/components/pms/DepositPanel";
import type { ReservationRow } from "@/components/pms/MovementBoard";

export const Route = createFileRoute("/_shell/pms/reservations/$id")({
  head: () => ({
    meta: [
      { title: "Reservation Detail — NEØ" },
      {
        name: "description",
        content:
          "Stay details, folio, charges, payments and the full change history for one booking.",
      },
      { property: "og:title", content: "Reservation Detail — NEØ" },
      {
        property: "og:description",
        content:
          "Stay details, folio, charges, payments and the full change history for one booking.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="reservations.view">
      <ReservationDetail />
    </PmsGuard>
  ),
});

function ReservationDetail() {
  const { id } = Route.useParams();
  const { organizationId, user, profile, can } = useAuth();
  const qc = useQueryClient();
  const reservation = useReservation(id);
  const folios = useReservationFolios(id);
  const history = useReservationHistory(id);
  const [cancelReason, setCancelReason] = useState("");

  const r = reservation.data as unknown as
    | (ReservationRow & {
        special_requests: string;
        guarantee_method: string;
        reservation_type: string;
        deposit_required: number;
        nightly_rate: number;
        payment_status: string;
        meal_plans: { code: string } | null;
        rate_plans: { name: string } | null;
        corporate_accounts: { legal_name: string; trading_name: string | null } | null;
        group_bookings: { name: string; reference: string } | null;
      })
    | null;

  const cancel = useMutation({
    mutationFn: async (nextStatus: "cancelled" | "no-show") => {
      if (!organizationId || !r) throw new Error("Reservation not loaded");
      if (!cancelReason.trim()) throw new Error("A reason is required");
      const { error } = await supabase
        .from("reservations")
        .update({
          status: nextStatus,
          cancellation_reason: cancelReason.trim(),
          cancelled_at: new Date().toISOString(),
          cancelled_by: user?.id ?? null,
        })
        .eq("id", r.id);
      if (error) throw error;
      await supabase.from("reservation_history").insert({
        organization_id: organizationId,
        reservation_id: r.id,
        action: nextStatus,
        previous_value: { status: r.status } as never,
        new_value: { status: nextStatus } as never,
        reason: cancelReason.trim(),
        changed_by: user?.id ?? null,
      });
      await logAudit({
        organizationId,
        userId: user?.id ?? null,
        userName: profile?.full_name,
        action: `pms.reservation.${nextStatus}`,
        module: "front-office",
        recordId: r.id,
        reason: cancelReason.trim(),
      });
    },
    onSuccess: () => {
      toast.success("Reservation updated");
      setCancelReason("");
      void qc.invalidateQueries({ queryKey: ["pms"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (reservation.isLoading)
    return <p className="text-sm text-muted-foreground">Loading reservation…</p>;
  if (!r) {
    return (
      <EmptyState
        title="Reservation not found"
        description="It may have been removed, or it belongs to another property."
        action={
          <Button asChild size="sm" variant="outline">
            <Link to="/pms/reservations">Back to reservations</Link>
          </Button>
        }
      />
    );
  }

  const folio = (folios.data ?? [])[0] as unknown as FolioWithLines | undefined;

  return (
    <div>
      <PageHeader
        eyebrow={`Reservation · ${titleCase(r.reservation_type)}`}
        title={r.confirmation_number}
        description={`${r.customers?.full_name ?? "Unnamed guest"} · ${formatDate(r.arrival_date)} → ${formatDate(r.departure_date)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/pms/reservations">
                <ArrowLeft className="mr-1 size-4" /> All reservations
              </Link>
            </Button>
            {r.status === "checked-in" ? (
              <>
                <AssignRoomDialog reservation={r} label="Move room" transfer />
                <CheckOutDialog reservation={r} balance={Number(folio?.balance ?? 0)} />
              </>
            ) : (
              <>
                <AssignRoomDialog
                  reservation={r}
                  label={r.room_id ? "Change room" : "Assign room"}
                />
                <CheckInDialog reservation={r} />
              </>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Tabs defaultValue="stay">
          <TabsList>
            <TabsTrigger value="stay">Stay</TabsTrigger>
            <TabsTrigger value="folio">Folio</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="manage">Manage</TabsTrigger>
          </TabsList>

          <TabsContent value="stay" className="mt-4">
            <SectionCard title="Stay details" description="">
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <Row label="Status" value={<ReservationStatusBadge status={r.status} />} />
                <Row label="Room" value={r.rooms?.room_number ?? "Unassigned"} />
                <Row label="Room type" value={r.room_types?.name ?? "—"} />
                <Row label="Rate plan" value={r.rate_plans?.name ?? "—"} />
                <Row label="Meal plan" value={r.meal_plans?.code ?? "—"} />
                <Row label="Nights" value={String(r.nights)} />
                <Row label="Party" value={`${r.adults} adult(s), ${r.children} child(ren)`} />
                <Row label="Source" value={titleCase(r.booking_source)} />
                <Row label="Guarantee" value={titleCase(r.guarantee_method)} />
                <Row label="Nightly rate" value={money(r.nightly_rate)} />
                <Row label="Total" value={money(r.total_amount)} />
                <Row label="Deposit required" value={money(r.deposit_required)} />
                {r.corporate_accounts ? (
                  <Row
                    label="Corporate"
                    value={r.corporate_accounts.trading_name ?? r.corporate_accounts.legal_name}
                  />
                ) : null}
                {r.group_bookings ? <Row label="Group" value={r.group_bookings.name} /> : null}
              </dl>
              <div className="mt-4">
                <DepositPanel reservationId={r.id} />
              </div>
              {r.special_requests ? (
                <div className="mt-4 rounded-lg border border-border/70 p-3 text-sm">
                  <p className="font-medium">Special requests</p>
                  <p className="mt-1 text-muted-foreground">{r.special_requests}</p>
                </div>
              ) : null}
            </SectionCard>
          </TabsContent>

          <TabsContent value="folio" className="mt-4">
            <SectionCard
              title={folio ? `Folio ${folio.folio_number}` : "Folio"}
              description="Charges post here from every module. The folio opens automatically at check-in."
              actions={
                folio ? (
                  <div className="flex flex-wrap gap-2">
                    <Button asChild variant="outline" size="sm">
                      {/* The folio number opens the folio itself, not the list. */}
                      <Link to="/pms/folios/$id" params={{ id: folio.id }}>
                        <ReceiptText className="mr-2 size-4" /> Open folio
                      </Link>
                    </Button>
                    <PostChargeDialog folioId={folio.id} />
                    <RecordPaymentDialog folioId={folio.id} balance={Number(folio.balance)} />
                    {Number(folio.balance) > 0 ? (
                      <MpesaPromptDialog
                        sourceModule="folio"
                        sourceRecordId={folio.id}
                        balance={Number(folio.balance)}

                        description={`Folio ${folio.folio_number}`}
                      />
                    ) : null}
                  </div>
                ) : null
              }
            >
              {!folio ? (
                <EmptyState
                  icon={ReceiptText}
                  title="No folio yet"
                  description="A folio is created automatically when the guest checks in."
                />
              ) : (
                <>
                  <div className="mb-4 flex flex-wrap items-center gap-3">
                    <FolioStatusBadge status={folio.status} />
                    <Badge variant="secondary">
                      Charges {money(folio.total_charges, folio.currency)}
                    </Badge>
                    <Badge variant="secondary">
                      Payments {money(folio.total_payments, folio.currency)}
                    </Badge>
                    <Badge>Balance {money(folio.balance, folio.currency)}</Badge>
                  </div>
                  <TableScroll>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead>Category</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(folio.folio_lines ?? []).length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-sm text-muted-foreground">
                              No charges posted yet.
                            </TableCell>
                          </TableRow>
                        ) : (
                          [...(folio.folio_lines ?? [])]
                            .sort((a, b) => a.posting_date.localeCompare(b.posting_date))
                            .map((line) => (
                              <TableRow key={line.id}>
                                <TableCell className="text-sm">
                                  {formatDateTime(line.posting_date)}
                                </TableCell>
                                <TableCell className="text-sm">{line.description}</TableCell>
                                <TableCell className="text-sm">
                                  {titleCase(line.category)}
                                </TableCell>
                                <TableCell className="text-right font-medium">
                                  {money(line.net_amount, folio.currency)}
                                </TableCell>
                              </TableRow>
                            ))
                        )}
                      </TableBody>
                    </Table>
                  </TableScroll>

                  <h3 className="mt-6 mb-2 text-sm font-semibold">Payments</h3>
                  {(folio.payments ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No payments recorded.</p>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {(folio.payments ?? []).map((p) => (
                        <li
                          key={p.id}
                          className="flex items-center justify-between rounded-lg border border-border/70 px-3 py-2"
                        >
                          <span>
                            {p.receipt_number} · {titleCase(p.method)} · {formatDateTime(p.paid_at)}
                          </span>
                          <span className="font-medium">{money(p.amount, folio.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </SectionCard>
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <SectionCard
              title="Change history"
              description="Every modification is recorded and cannot be edited."
            >
              <QueryState
                isLoading={history.isLoading}
                error={history.error}
                isEmpty={(history.data ?? []).length === 0}
                empty={
                  <EmptyState
                    title="No changes recorded"
                    description="Modifications will appear here."
                  />
                }
              >
                <ul className="space-y-3">
                  {(history.data ?? []).map((h) => (
                    <li key={h.id} className="rounded-lg border border-border/70 p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{titleCase(h.action)}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(h.created_at)}
                        </span>
                      </div>
                      {h.reason ? <p className="mt-1 text-muted-foreground">{h.reason}</p> : null}
                    </li>
                  ))}
                </ul>
              </QueryState>
            </SectionCard>
          </TabsContent>

          <TabsContent value="manage" className="mt-4">
            <SectionCard
              title="Cancellation & no-show"
              description="Both actions require a reason and are written to the audit trail."
            >
              {can("pms", "reservations.cancel") || can("pms", "reservations.edit") ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <Label>Reason</Label>
                    <Textarea
                      value={cancelReason}
                      onChange={(e) => setCancelReason(e.target.value)}
                      rows={3}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {can("pms", "reservations.cancel") ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={!cancelReason.trim() || cancel.isPending}
                        onClick={() => cancel.mutate("cancelled")}
                      >
                        Cancel reservation
                      </Button>
                    ) : null}
                    {can("pms", "reservations.edit") ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!cancelReason.trim() || cancel.isPending}
                        onClick={() => cancel.mutate("no-show")}
                      >
                        Mark as no-show
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  You do not have permission to cancel this reservation.
                </p>
              )}
            </SectionCard>
          </TabsContent>
        </Tabs>

        <SectionCard title="Guest" description="">
          <dl className="space-y-3 text-sm">
            <Row label="Name" value={r.customers?.full_name ?? "—"} />
            <Row label="VIP" value={r.is_vip ? "Yes" : "No"} />
            <Row label="Payment status" value={titleCase(r.payment_status)} />
            <Row label="Balance" value={money(folio?.balance ?? r.balance)} />
          </dl>
        </SectionCard>
      </div>
    </div>
  );
}

type FolioWithLines = {
  id: string;
  folio_number: string;
  status: string;
  currency: string;
  balance: number;
  total_charges: number;
  total_payments: number;
  folio_lines: {
    id: string;
    posting_date: string;
    description: string;
    category: string;
    net_amount: number;
  }[];
  payments: {
    id: string;
    receipt_number: string;
    method: string;
    paid_at: string;
    amount: number;
  }[];
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/50 pb-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}
