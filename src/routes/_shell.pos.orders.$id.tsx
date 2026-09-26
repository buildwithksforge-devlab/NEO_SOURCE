import { MENU_OUTLET_LABELS, outletForOrder, scopeCatalogueToOutlet } from "@/lib/menu-scoping";
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { BedDouble, Send, Trash2 } from "lucide-react";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { AddItemDialog } from "@/components/pos/AddItemDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MpesaPromptDialog } from "@/components/payments/MpesaPromptDialog";
import {
  EmptyState,
  ItemStatusBadge,
  OrderStatusBadge,
  PosGuard,
  QueryState,
} from "@/components/pos/PosShared";
import { methodsFor, PaymentMethodPicker } from "@/components/payments/PaymentMethodPicker";
import { ReceivingAccountSelect } from "@/components/payments/ReceivingAccountSelect";
import { QrPaymentPanel } from "@/components/payments/QrPaymentPanel";
import { useAuth } from "@/lib/auth";
import { useRequestPosCashPayment, useTillContext } from "@/lib/cash-routing";
import {
  useDispatchPaymentIntent,
  useOpenPaymentIntent,
  usePaymentIntentStatus,
} from "@/lib/payment-intents";
import { paymentMethod } from "@/lib/payment-methods";
import { COURSES, EXTERNAL_METHODS, allowedTransitions, money, titleCase } from "@/lib/pos";
import {
  useAddOrderItem,
  useCheckedInStays,
  useMenuCategories,
  useMenuCatalogue,
  useMyOpenShift,
  useOpenFolioForStay,
  explainPosStatusError,
  usePosOrder,
  usePosOrderDiagnostics,
  usePostRoomCharge,
  usePosDiscountPolicies,
  useApplyPosDiscount,
  useConfirmManualPayment,
  useRecordPayment,
  useReconcileSettlement,
  useRemoveDraftItem,
  useRequestVoid,
  useSendOrder,
  useUpdateItemStatus,
} from "@/lib/pos-data";

export const Route = createFileRoute("/_shell/pos/orders/$id")({
  head: () => ({
    meta: [
      { title: "Order Terminal — NEØ" },
      {
        name: "description",
        content:
          "Take items, fire them to the right station, settle the bill or charge it to a guest room folio.",
      },
      { property: "og:title", content: "Order Terminal — NEØ" },
      {
        property: "og:description",
        content:
          "Take items, fire them to the right station, settle the bill or charge it to a guest room folio.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="orders.view">
      <OrderTerminal />
    </PosGuard>
  ),
});

function OrderTerminal() {
  const { id } = Route.useParams();
  const { can } = useAuth();
  const order = usePosOrder(id);
  // The terminal sells only from the canonical catalogue: published, scoped
  // rows carrying the station the ticket will actually be routed to.
  const items = useMenuCatalogue(false, order.data?.branch_id ?? null);

  const categories = useMenuCategories();
  const shift = useMyOpenShift();

  const addItem = useAddOrderItem();
  // Items are configured in a dialog first: quantity, catalogue choices,
  // special instructions and any allergy go onto the line as it is created, so
  // nothing has to be attached to a second order afterwards.
  const [pendingItem, setPendingItem] = useState<{
    id: string;
    name: string;
    base_price: number;
    tax_rate: number;
    station_id: string | null;
  } | null>(null);
  const removeItem = useRemoveDraftItem();
  const send = useSendOrder();
  // Only fetched when a transition was actually rejected — the server rulebook
  // is then shown verbatim so a UI/RPC mismatch cannot recur silently.
  const diagnostics = usePosOrderDiagnostics(id, send.isError);
  const itemStatus = useUpdateItemStatus();
  const requestVoid = useRequestVoid();
  const reconcile = useReconcileSettlement();
  const confirmManual = useConfirmManualPayment();
  const canManualConfirm = can("pos", "orders.approve");
  const discountPolicies = usePosDiscountPolicies();
  const applyDiscount = useApplyPosDiscount();
  const [discountChoice, setDiscountChoice] = useState("none");

  const [category, setCategory] = useState("all");
  const [search, setSearch] = useState("");
  const [course, setCourse] = useState<string>("main");
  const [payOpen, setPayOpen] = useState(false);
  const [roomOpen, setRoomOpen] = useState(false);
  const [voidItem, setVoidItem] = useState<{
    id: string;
    name: string;
    total: number;
    status: string;
  } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [confirmPayment, setConfirmPayment] = useState<{
    id: string;
    amount: number;
    method: string;
  } | null>(null);
  const [confirmNote, setConfirmNote] = useState("");

  const q = search.trim().toLowerCase();
  // A bar tab sells the bar's menus, not the whole hotel catalogue: the
  // outlet comes from the order itself, so the same terminal serves each
  // outlet correctly.
  const outlet = outletForOrder(
    order.data?.order_type ?? null,
    (
      order.data?.restaurant_tables as {
        restaurant_areas?: { outlet?: string | null } | null;
      } | null
    )?.restaurant_areas?.outlet ?? null,
  );
  const scoped = scopeCatalogueToOutlet(items.data ?? [], outlet);
  const menuRows = scoped.rows.filter(
    (m) =>
      m.availability !== "discontinued" &&
      (category === "all" || m.category_id === category) &&
      (!q || m.name.toLowerCase().includes(q)),
  );
  const outletLabel = outlet ? MENU_OUTLET_LABELS[outlet] : null;

  const data = order.data;
  const lines = useMemo(
    () =>
      [...(data?.pos_order_items ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [data],
  );
  const unsent = lines.filter((l) => l.status === "draft");
  // A draft line with no production station would be marked Sent while the
  // kitchen never sees it, so Send is refused until every line can be routed.
  const unroutable = unsent.filter((l) => !l.station_id);
  const balance = Number(data?.grand_total ?? 0) - Number(data?.paid_total ?? 0);
  const openItems = lines.filter(
    (l) => !["served", "cancelled", "voided"].includes(l.status),
  ).length;

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title={data ? `Order ${data.order_number}` : "Order"}
        description={
          data
            ? `${titleCase(data.order_type)} · ${data.restaurant_tables?.code ?? data.guest_name ?? "Walk-in"} · ${data.guest_count} guest(s)`
            : "Loading order"
        }
        actions={
          data ? (
            <>
              <OrderStatusBadge status={data.status} />
              <DocumentPrintButton
                type="pos_receipt"
                id={data.id}
                label="Print receipt"
                size="default"
              />
            </>
          ) : null
        }
      />

      <QueryState
        isLoading={order.isLoading}
        error={order.error}
        isEmpty={!data}
        empty={
          <EmptyState title="Order not found" description="This order may have been removed." />
        }
      >
        {data ? (
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="space-y-4 lg:col-span-3">
              <SectionCard
                title="Menu"
                description="Only items marked available in the menu can be added."
              >
                <div className="mb-3 flex flex-wrap gap-2">
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger className="w-52" aria-label="Menu category">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All categories</SelectItem>
                      {(categories.data ?? []).map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={course} onValueChange={setCourse}>
                    <SelectTrigger className="w-40" aria-label="Course">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COURSES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {titleCase(c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    className="w-52"
                    placeholder="Search menu"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>

                <QueryState
                  isLoading={items.isLoading}
                  error={items.error}
                  isEmpty={menuRows.length === 0}
                  empty={
                    <EmptyState
                      title={
                        outletLabel && !scoped.outletConfigured
                          ? `No ${outletLabel.toLowerCase()} menu configured`
                          : "No menu items"
                      }
                      description={
                        outletLabel && !scoped.outletConfigured
                          ? `This terminal is trading as ${outletLabel}. Create a menu under Menu and set its outlet to ${outletLabel} — items from other outlets are deliberately not offered here.`
                          : "Build your menu under Menu before taking orders."
                      }
                    />
                  }
                >
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {menuRows.map((m) => (
                      <button
                        key={m.id}
                        disabled={
                          !can("pos", "orders.create") ||
                          m.availability === "out-of-stock" ||
                          m.station_missing
                        }
                        title={
                          m.station_missing
                            ? "This item has no production station, so the kitchen would never receive it."
                            : undefined
                        }
                        onClick={() =>
                          setPendingItem({
                            id: m.id,
                            name: m.name,
                            base_price: m.base_price,
                            tax_rate: m.tax_rate ?? 0,
                            station_id: m.station_id,
                          })
                        }
                        className="rounded-xl border border-border bg-card p-3 text-left transition-shadow hover:shadow-lift disabled:opacity-50"
                      >
                        <p className="text-sm font-semibold">{m.name}</p>
                        <p className="text-xs text-muted-foreground">{money(m.base_price)}</p>
                        {m.availability !== "available" ? (
                          <StatusPill tone="warning">{titleCase(m.availability)}</StatusPill>
                        ) : null}
                        {m.station_missing ? (
                          <StatusPill tone="destructive">No production station</StatusPill>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </QueryState>
              </SectionCard>
            </div>

            <AddItemDialog
              item={pendingItem}
              busy={addItem.isPending}
              onOpenChange={(open) => !open && setPendingItem(null)}
              onConfirm={(choice) => {
                if (!pendingItem) return;
                addItem.mutate({
                  orderId: data.id,
                  item: {
                    id: pendingItem.id,
                    name: pendingItem.name,
                    description: null,
                    base_price: pendingItem.base_price,
                    tax_rate: pendingItem.tax_rate,
                    station_id: pendingItem.station_id,
                  },
                  quantity: choice.quantity,
                  course,
                  ...(choice.instructions ? { instructions: choice.instructions } : {}),
                  ...(choice.allergyNote ? { allergyNote: choice.allergyNote } : {}),
                  ...(choice.modifiers.length ? { modifiers: choice.modifiers } : {}),
                });
                setPendingItem(null);
              }}
            />

            <div className="space-y-4 lg:col-span-2">
              <SectionCard
                title="Bill"
                description="Sent items can only be removed through an approved void."
                actions={
                  <Button
                    size="sm"
                    disabled={unsent.length === 0 || send.isPending || unroutable.length > 0}
                    onClick={() => send.mutate(data.id)}
                  >
                    <Send className="mr-2 size-4" /> Send{" "}
                    {unsent.length ? `(${unsent.length})` : ""}
                  </Button>
                }
              >
                {unroutable.length > 0 ? (
                  <div className="mb-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                    <p className="text-sm font-semibold text-destructive">
                      {unroutable.length} item(s) have no production station
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Assign a station to these items under Menu before sending — otherwise the bill
                      would read Sent while the kitchen received nothing.
                    </p>
                  </div>
                ) : null}
                {send.isError ? (
                  <div
                    data-testid="pos-transition-diagnostics"
                    className="mb-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3"
                  >
                    <p className="text-sm font-semibold text-destructive">
                      {explainPosStatusError((send.error as Error).message)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Current status:{" "}
                      <span className="font-medium">
                        {titleCase(diagnostics.data?.status ?? data.status)}
                      </span>{" "}
                      · Payment:{" "}
                      <span className="font-medium">
                        {titleCase(diagnostics.data?.paymentStatus ?? data.payment_status)}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Allowed next (server rulebook):{" "}
                      {(diagnostics.data?.allowedNext ?? allowedTransitions(data.status))
                        .map(titleCase)
                        .join(", ") || "none"}
                    </p>
                  </div>
                ) : null}
                {lines.length === 0 ? (
                  <EmptyState
                    title="No items yet"
                    description="Tap menu items to add them to this bill."
                  />
                ) : (
                  <ul className="divide-y divide-border">
                    {lines.map((l) => (
                      <li key={l.id} className="flex items-start justify-between gap-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {l.quantity} × {l.item_name}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {titleCase(l.course)} · {l.operational_stations?.name ?? "No station"}
                          </p>
                          <ItemStatusBadge status={l.status} />
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span className="text-sm">{money(l.line_total)}</span>
                          {l.status === "draft" ? (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="Remove item"
                              onClick={() => removeItem.mutate({ itemId: l.id, orderId: data.id })}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          ) : l.status === "ready" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => itemStatus.mutate({ itemId: l.id, status: "served" })}
                            >
                              Serve
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setVoidItem({
                                  id: l.id,
                                  name: l.item_name,
                                  total: Number(l.line_total),
                                  status: l.status,
                                })
                              }
                            >
                              Void
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {can("pos", "discount.execute") && data.status !== "closed" ? (
                  <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-border pt-3">
                    <div className="min-w-[220px] flex-1 space-y-1.5">
                      <Label htmlFor="bill-discount">Discount</Label>
                      <Select
                        value={discountChoice}
                        onValueChange={(v) => {
                          const policy = (discountPolicies.data ?? []).find((d) => d.id === v);
                          const subtotal = Number(data.subtotal ?? 0);
                          const rawDiscount = policy
                            ? policy.discount_type === "percentage"
                              ? (subtotal * Number(policy.value ?? 0)) / 100
                              : Number(policy.value ?? 0)
                            : 0;
                          const cappedDiscount = policy?.max_value == null
                            ? rawDiscount
                            : Math.min(rawDiscount, Number(policy.max_value));
                          const effectivePercent = subtotal > 0
                            ? (Math.min(cappedDiscount, subtotal) / subtotal) * 100
                            : 0;
                          let reason: string | undefined;
                          if (policy && (policy.requires_approval || effectivePercent > 15)) {
                            reason = window.prompt(
                              effectivePercent > 15
                                ? "Owner approval reason for this discount (required):"
                                : "Reason for this approved discount (required):",
                            )?.trim();
                            if (!reason) return;
                          }
                          setDiscountChoice(v);
                          applyDiscount.mutate({
                            orderId: data.id,
                            discountId: v === "none" ? null : v,
                            ...(reason ? { reason } : {}),
                          });
                        }}
                        disabled={applyDiscount.isPending || !(discountPolicies.data?.length ?? 0)}
                      >
                        <SelectTrigger id="bill-discount">
                          <SelectValue
                            placeholder={
                              discountPolicies.data?.length
                                ? "No discount"
                                : "No discount policies configured"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No discount</SelectItem>
                          {(discountPolicies.data ?? []).map((d) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.name}
                              {d.discount_type === "percentage" ? ` · ${d.value}%` : ` · ${money(d.value)}`}
                              {d.requires_approval ? " · needs approval" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Only configured policies may be applied. Operations Manager approval is capped
                      at 15%; anything above 15% is Owner-only.
                    </p>
                  </div>
                ) : null}

                <dl className="mt-4 space-y-1 border-t border-border pt-3 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Subtotal</dt>
                    <dd>{money(data.subtotal)}</dd>
                  </div>
                  {Number(data.discount_total ?? 0) > 0 ? (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Discount</dt>
                      <dd>- {money(data.discount_total)}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Tax</dt>
                    <dd>{money(data.tax_total)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Service charge</dt>
                    <dd>{money(data.service_charge_total)}</dd>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <dt>Total</dt>
                    <dd>{money(data.grand_total)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Paid</dt>
                    <dd>{money(data.paid_total)}</dd>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <dt>Balance</dt>
                    <dd>{money(balance)}</dd>
                  </div>
                </dl>

                <div className="mt-4 grid gap-2">
                  <Button
                    disabled={!can("pos", "orders.edit") || balance <= 0}
                    onClick={() => setPayOpen(true)}
                  >
                    Take payment
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!can("pos", "orders.approve") || balance <= 0}
                    onClick={() => setRoomOpen(true)}
                  >
                    <BedDouble className="mr-2 size-4" /> Charge to room
                  </Button>
                  {can("pos", "orders.edit") && balance > 0 ? (
                    <MpesaPromptDialog
                      sourceModule="pos_order"
                      sourceRecordId={data.id}
                      balance={balance}
                      description={`Bill ${data.order_number ?? data.id.slice(0, 8)}`}
                      onSettled={() => void order.refetch()}
                    />
                  ) : null}

                  {data.status !== "closed" && Number(data.grand_total) > 0 ? (
                    <Button
                      variant="ghost"
                      disabled={reconcile.isPending}
                      onClick={() => reconcile.mutate(data.id)}
                    >
                      Reconcile &amp; close if eligible
                    </Button>
                  ) : null}
                  {openItems > 0 && balance <= 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {openItems} item(s) are still in preparation. The bill closes once they are
                      served, cancelled or voided.
                    </p>
                  ) : null}
                </div>
              </SectionCard>

              <SectionCard
                title="Payments"
                description="Every settlement attempt is recorded, including pending ones."
              >
                {(data.pos_payments ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {data.pos_payments.map((p) => (
                      <li key={p.id} className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          {titleCase(p.method)}
                          {p.external_reference ? ` · ${p.external_reference}` : ""}
                          {p.verification_note ? (
                            <span className="block text-xs text-muted-foreground">
                              Manually confirmed — {p.verification_note}
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          {money(p.amount)}
                          <StatusPill
                            tone={
                              p.status === "confirmed"
                                ? "success"
                                : p.status === "failed"
                                  ? "destructive"
                                  : "warning"
                            }
                          >
                            {titleCase(p.status)}
                          </StatusPill>
                          {canManualConfirm &&
                          (p.status === "pending" || p.status === "initiated") ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                setConfirmPayment({
                                  id: p.id,
                                  amount: Number(p.amount),
                                  method: p.method,
                                })
                              }
                            >
                              Confirm
                            </Button>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            </div>
          </div>
        ) : null}
      </QueryState>

      {data ? (
        <>
          <PaymentDialog
            open={payOpen}
            onOpenChange={setPayOpen}
            orderId={data.id}
            balance={balance}
            shiftId={shift.data?.id ?? null}
          />
          <RoomChargeDialog
            open={roomOpen}
            onOpenChange={setRoomOpen}
            orderId={data.id}
            balance={balance}
          />
          <Dialog
            open={Boolean(confirmPayment)}
            onOpenChange={(o) => !o && setConfirmPayment(null)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Confirm payment manually</DialogTitle>
                <DialogDescription>
                  {confirmPayment
                    ? `${titleCase(confirmPayment.method)} · ${money(confirmPayment.amount)}. `
                    : ""}
                  The provider is not connected, so this confirmation is recorded against your name
                  with the note below.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="confirm-note">Verification note</Label>
                <Textarea
                  id="confirm-note"
                  value={confirmNote}
                  onChange={(e) => setConfirmNote(e.target.value)}
                  placeholder="How was this payment verified?"
                />
              </div>
              <DialogFooter>
                <Button
                  disabled={!confirmNote.trim() || confirmManual.isPending}
                  onClick={() => {
                    if (!confirmPayment) return;
                    confirmManual.mutate(
                      { paymentId: confirmPayment.id, note: confirmNote.trim() },
                      {
                        onSuccess: () => {
                          setConfirmPayment(null);
                          setConfirmNote("");
                        },
                      },
                    );
                  }}
                >
                  Confirm payment
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Dialog open={Boolean(voidItem)} onOpenChange={(o) => !o && setVoidItem(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Request void — {voidItem?.name}</DialogTitle>
                <DialogDescription>
                  Sent items require manager approval. The request records who asked, why, and the
                  preparation state.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="void-reason">Reason</Label>
                <Textarea
                  id="void-reason"
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                />
              </div>
              <DialogFooter>
                <Button
                  disabled={!voidReason.trim()}
                  onClick={() => {
                    if (!voidItem) return;
                    requestVoid.mutate({
                      orderId: data.id,
                      orderItemId: voidItem.id,
                      kind: "item-void",
                      amount: voidItem.total,
                      reason: voidReason,
                      preparationStatus: voidItem.status,
                    });
                    setVoidReason("");
                    setVoidItem(null);
                  }}
                >
                  Send for approval
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}

function PaymentDialog({
  open,
  onOpenChange,
  orderId,
  balance,
  shiftId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orderId: string;
  balance: number;
  shiftId: string | null;
}) {
  const record = useRecordPayment();
  // Cash never settles straight from the billing screen: it follows the same
  // request → cashier confirmation path as folio billing, so the notes are
  // always attributed to a named, open till.
  const routeCash = useRequestPosCashPayment();
  const till = useTillContext();
  const { can } = useAuth();
  const [method, setMethod] = useState("cash");
  const [amount, setAmount] = useState(String(balance.toFixed(2)));
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");
  const [manualConfirm, setManualConfirm] = useState(false);
  const [note, setNote] = useState("");
  // Where the money lands. Separate from the method, which is how it was paid.
  const [account, setAccount] = useState<string | null>(null);
  // One key per settlement attempt: a double-click can never charge twice, but a
  // genuine second payment of the same amount still goes through.
  const [attemptKey, setAttemptKey] = useState(() => crypto.randomUUID());
  // A card terminal or QR app answers for itself: the request is opened here and
  // the bill only settles when the processor's own answer arrives.
  const openIntent = useOpenPaymentIntent();
  const dispatchIntent = useDispatchPaymentIntent();
  const [intentId, setIntentId] = useState<string | null>(null);
  const [intentProblem, setIntentProblem] = useState<string | null>(null);
  const [qr, setQr] = useState<{ payload: string | null; imageUrl: string | null } | null>(null);
  const intent = usePaymentIntentStatus(intentId);
  const definition = paymentMethod(method);
  const providerBacked = definition?.kind === "provider";
  const terminalMethod = method === "card-terminal" || method === "qr";
  const external = Boolean(EXTERNAL_METHODS[method]);
  const canManualConfirm = can("pos", "orders.approve");
  const amountValue = Number(amount);
  const overpaying = amountValue > balance + 0.005;
  const isCash = method === "cash";
  const selfService = Boolean(till.data?.self_service);
  const blocked =
    !amountValue ||
    amountValue <= 0 ||
    overpaying ||
    (manualConfirm && !note.trim()) ||
    record.isPending ||
    routeCash.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Take payment</DialogTitle>
          <DialogDescription>Outstanding balance {money(balance)}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <PaymentMethodPicker
            methods={methodsFor([
              "cash",
              "card",
              "card-terminal",
              "mpesa",
              "qr",
              "bank-transfer",
              "corporate-credit",
              "voucher",
              "ota-prepaid",
            ])}
            value={method}
            onChange={(next) => {
              setMethod(next);
              setIntentId(null);
              setIntentProblem(null);
              setManualConfirm(false);
            }}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="pay-amount">Amount</Label>
            <Input
              id="pay-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
          </div>
          {method === "cash" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="pay-tendered">Cash tendered</Label>
              <Input
                id="pay-tendered"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                inputMode="decimal"
              />
              {Number(tendered) > Number(amount) ? (
                <p className="text-xs text-muted-foreground">
                  Change due {money(Number(tendered) - Number(amount))}
                </p>
              ) : null}
              <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
                {selfService
                  ? `Settles straight into your own open till${till.data?.my_shift_number ? ` (${till.data.my_shift_number})` : ""}, with a receipt and audit entry.`
                  : "You do not hold an open till, so this is routed to an active cashier who confirms the cash physically received before the bill is settled."}
              </p>
            </div>
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor="pay-ref">
                {terminalMethod ? "Your own reference (optional)" : "Reference"}
              </Label>
              <Input
                id="pay-ref"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder={
                  terminalMethod
                    ? "The processor supplies its own reference"
                    : "Slip, transfer or voucher number"
                }
              />
              {!providerBacked ? (
                <p className="text-xs text-muted-foreground">
                  Recorded against this bill straight away and marked unverified until someone
                  checks it against the slip or statement.
                </p>
              ) : null}
            </div>
          )}
          {external ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
              {EXTERNAL_METHODS[method]} confirms this payment itself. It is held as{" "}
              <strong>awaiting confirmation</strong> until that answer arrives — nothing is marked
              paid on trust.
            </p>
          ) : null}
          {intentProblem ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs">
              {intentProblem}
            </p>
          ) : null}
          {qr ? <QrPaymentPanel payload={qr.payload} imageUrl={qr.imageUrl} /> : null}
          {intentId && intent.data?.ok ? (
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
              Request sent to the {titleCase(method.replace("-", " "))}. Current answer:{" "}
              <strong>
                {titleCase(String(intent.data.state ?? "requested").replace("_", " "))}
              </strong>
              . {intent.data.detail ?? ""}
            </p>
          ) : null}
          {external && canManualConfirm ? (
            <div className="grid gap-2 rounded-lg border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={manualConfirm}
                  onChange={(e) => setManualConfirm(e.target.checked)}
                />
                Manual confirmed (controlled testing)
              </label>
              <p className="text-xs text-muted-foreground">
                Confirms the payment without a provider response. Your name and note are stored with
                the settlement.
              </p>
              {manualConfirm ? (
                <Textarea
                  aria-label="Verification note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="How was this payment verified?"
                />
              ) : null}
            </div>
          ) : null}
          {isCash ? null : (
            <ReceivingAccountSelect id="pos-receiving-account" value={account} onChange={setAccount} />
          )}
          {overpaying ? (
            <p className="text-xs text-destructive">
              The amount cannot exceed the outstanding balance of {money(balance)}.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            disabled={blocked}
            onClick={() => {
              if (isCash) {
                routeCash.mutate(
                  {
                    order: orderId,
                    amount: amountValue,
                    ...(reference ? { reference } : {}),
                    idempotencyKey: `pos-cash:${orderId}:${attemptKey}`,
                  },
                  {
                    onSuccess: (result) => {
                      setAttemptKey(crypto.randomUUID());
                      if (result.status !== "no_till") onOpenChange(false);
                    },
                  },
                );
                return;
              }
              const ownReference =
                reference || (terminalMethod ? `REQ-${attemptKey.slice(0, 8).toUpperCase()}` : "");
              record.mutate(
                {
                  orderId,
                  amount: amountValue,
                  method,
                  ...(account ? { destinationAccountId: account } : {}),
                  ...(Number(tendered) ? { tendered: Number(tendered) } : {}),
                  ...(ownReference ? { externalReference: ownReference } : {}),
                  shiftId,
                  idempotencyKey: `pos-pay:${orderId}:${attemptKey}`,
                  manualConfirm: manualConfirm && external,
                  ...(manualConfirm && note.trim() ? { note: note.trim() } : {}),
                },
                {
                  onSuccess: (result: unknown) => {
                    setNote("");
                    setManualConfirm(false);
                    const paymentId = (result as { payment_id?: string } | null)?.payment_id;
                    // A terminal or QR request stays on screen: the bill only
                    // settles when the processor answers for itself.
                    if (terminalMethod && !manualConfirm && paymentId) {
                      openIntent.mutate(
                        {
                          module: "pos",
                          sourceRecord: orderId,
                          method,
                          amount: amountValue,
                          reference: ownReference,
                          linkTable: "pos_payments",
                          linkId: paymentId,
                        },
                        {
                          onSuccess: (opened) => {
                            if (opened.ok && opened.intent_id) {
                              const id = opened.intent_id;
                              setIntentId(id);
                              setIntentProblem(null);
                              dispatchIntent.mutate(
                                { intentId: id },
                                {
                                  onSuccess: (sent) => {
                                    if (sent.qrPayload || sent.qrImageUrl) {
                                      setQr({
                                        payload: sent.qrPayload ?? null,
                                        imageUrl: sent.qrImageUrl ?? null,
                                      });
                                    }
                                    if (!sent.ok) {
                                      setIntentProblem(
                                        sent.detail ??
                                          "The request could not be sent to the processor, so this payment stays awaiting confirmation.",
                                      );
                                    }
                                  },
                                  onError: (e: Error) => setIntentProblem(e.message),
                                },
                              );
                            } else {
                              setIntentProblem(
                                opened.detail ??
                                  "No processor is connected for this method, so the payment stays awaiting confirmation.",
                              );
                            }
                          },
                          onError: (e: Error) => setIntentProblem(e.message),
                        },
                      );
                      setAttemptKey(crypto.randomUUID());
                      return;
                    }
                    setAttemptKey(crypto.randomUUID());
                    onOpenChange(false);
                  },
                },
              );
            }}
          >
            {isCash
              ? selfService
                ? "Confirm cash received"
                : "Send to cashier"
              : manualConfirm && external
                ? "Record & confirm"
                : terminalMethod
                  ? "Send to terminal"
                  : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoomChargeDialog({
  open,
  onOpenChange,
  orderId,
  balance,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orderId: string;
  balance: number;
}) {
  const stays = useCheckedInStays();
  const [stayId, setStayId] = useState<string>("");
  const folio = useOpenFolioForStay(stayId || undefined);
  const post = usePostRoomCharge();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Charge to guest room</DialogTitle>
          <DialogDescription>
            Only checked-in stays with an open folio can be charged. {money(balance)} will be posted
            as a folio line.
          </DialogDescription>
        </DialogHeader>
        {(stays.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            There are no in-house guests to charge right now.
          </p>
        ) : (
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>In-house guest</Label>
              <Select value={stayId} onValueChange={setStayId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select guest" />
                </SelectTrigger>
                <SelectContent>
                  {(stays.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.rooms?.room_number ?? "Room"} · {s.customers?.full_name ?? "Guest"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {stayId ? (
              folio.data ? (
                <p className="text-sm text-muted-foreground">
                  Folio {folio.data.folio_number} · balance {money(folio.data.balance)}
                </p>
              ) : (
                <p className="text-sm text-destructive">
                  This stay has no open folio, so it cannot be charged.
                </p>
              )
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button
            disabled={!folio.data || post.isPending}
            onClick={() =>
              post.mutate(
                { orderId, folioId: folio.data!.id },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            Post charge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
