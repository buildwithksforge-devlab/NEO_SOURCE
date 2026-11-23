import { PaymentDialog } from "@/components/pos/PosPaymentDialog";
import {PosRefundPanel} from "@/components/pos/PosRefundPanel";
import {outstandingPaidBill} from '@/lib/pos-payment-display';
import {posRoomTransferState} from '@/lib/pos-room-transfer';
import { MENU_OUTLET_LABELS, outletForOrder, scopeCatalogueToOutlet } from "@/lib/menu-scoping";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BedDouble, Send, Trash2 } from "lucide-react";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { FileWithKraButton } from "@/components/finance/FileWithKraButton";
import { getPosFiscalStatus } from "@/lib/etims.functions";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { AddItemDialog } from "@/components/pos/AddItemDialog";
import { StockAwareMenuItem } from "@/components/pos/StockAwareMenuItem";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { usePosReceiptPrintState } from "@/lib/printing";
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
import { useAuth } from "@/lib/auth";
import { usePendingPosCashRequests } from "@/lib/cash-routing";
import { SendToPrinterButton } from "@/components/common/SendToPrinterButton";
import { COURSES, allowedTransitions, money, titleCase } from "@/lib/pos";
import {
  useAddOrderItem,
  useCheckedInStays,
  useMenuCategories,
  useMenuCatalogue,
  useMyOpenShift,
  useOpenFolioForStay,
  explainPosStatusError,
  usePosOrder,
  usePosStockAvailability,
  usePosOrderDiagnostics,
  usePostRoomCharge,
  usePosDiscountPolicies,
  useApplyPosDiscount,
  useConfirmManualPayment,
  useSubmitMpesaReceiptReview,
  useMpesaReceiptReviewQueue,
  useReconcileSettlement,
  useRemoveDraftItem,
  useRemoveDraftOrder,
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

function SavedItemTaxes({ snapshot }: { snapshot: unknown }) {
  if (!snapshot || typeof snapshot !== "object" || !("taxes" in snapshot) || !Array.isArray(snapshot.taxes)) return null;
  return (
    <ul className="text-xs text-muted-foreground" aria-label="Saved item taxes before bill discounts">
      {snapshot.taxes.map((tax, index) => {
        if (!tax || typeof tax.name !== "string" || typeof tax.amount !== "number") return null;
        const rate = tax.method === "percentage" && typeof tax.value === "number" && Number.isFinite(tax.value)
          ? `${new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 4 }).format(tax.value)} `
          : "";
        return <li key={`${tax.code}-${index}`}>{rate}{tax.name} · {money(tax.amount)} {tax.inclusive ? "included" : "added"}</li>;
      })}
    </ul>
  );
}

function OrderTerminal() {
  const navigate = useNavigate();
  const { id } = Route.useParams();
  const { can } = useAuth();
  const order = usePosOrder(id);
  const stockOut = usePosStockAvailability(order.data?.branch_id, order.data?.order_type);
  const [stockIssue, setStockIssue] = useState<string | null>(null);
  const removeDraftOrder = useRemoveDraftOrder();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeReason, setRemoveReason] = useState("");
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
  const canManualConfirm = can("pos", "payments", "manual-confirm");
  const canSubmitReceipt = can("pos", "payments", "process") || canManualConfirm
    || can("finance", "collections", "verify_bill")
    || can("finance", "till", "confirm_cash") || can("finance", "approve");
  const submitReceipt = useSubmitMpesaReceiptReview();
  const receiptReviews = useMpesaReceiptReviewQueue(order.data?.branch_id ?? null);
  const discountPolicies = usePosDiscountPolicies();
  const applyDiscount = useApplyPosDiscount();
  const receiptPrintState = usePosReceiptPrintState(id);
  const pendingCash = usePendingPosCashRequests(id);
  const hasCompletedReceiptPrint = receiptPrintState.data?.hasCompletedPrint ?? false;
  const canReprintReceipt = can("pos", "receipts.reprint");
  const loadPosFiscalStatus = useServerFn(getPosFiscalStatus);

  const fiscalEligible =
    Boolean(order.data) &&
    !order.data?.folio_id &&
    ["closed", "paid", "settled", "completed"].includes(String(order.data?.status ?? "")) &&
    (order.data?.payment_status === "paid" ||
      Number(order.data?.paid_total ?? 0) >= Number(order.data?.grand_total ?? 0));

  const fiscalStatus = useQuery({
    queryKey: ["pos", "etims", id],
    queryFn: () => loadPosFiscalStatus({ data: { posOrderId: id } }),
    enabled: fiscalEligible,
  });

  const fiscalState = String(fiscalStatus.data?.status ?? "not_filed");
  const fiscalAccepted = fiscalState === "accepted";
  const fiscalPending = ["queued", "submitted", "pending"].includes(fiscalState);
  const fiscalFailed = ["failed", "retry_required", "rejected"].includes(fiscalState);
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
  const [confirmReceipt, setConfirmReceipt] = useState("");

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
      ["available", "out-of-stock"].includes(m.availability) && m.publish_status === "published" &&
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
  const activeReceiptReview = (data?.pos_payments ?? []).some(payment => receiptReviews.data?.some(review =>
    review.payment_id === payment.id && ["pending_approval", "approved_pending_execution", "executing", "execution_failed"].includes(review.status)));
  const roomTransfer = posRoomTransferState(data, activeReceiptReview);
  const reviewsUnknown = receiptReviews.isPending || receiptReviews.isFetching || receiptReviews.isError;
  const canTransferRoom = roomTransfer.canTransfer && !reviewsUnknown;
  const roomTransferReason = reviewsUnknown ? "Receipt reviews could not yet be verified. Refresh before transferring this bill." : roomTransfer.reason;
  const balance = roomTransfer.amountDue ?? 0;
  const openItems = lines.filter(
    (l) => !["served", "cancelled", "voided"].includes(l.status),
  ).length;
  const removableDraft = data?.status === "draft" && data.payment_status === "unpaid"
    && Number(data.paid_total ?? 0) === 0 && !data.folio_id
    && (data.pos_payments ?? []).length === 0
    && lines.every(line => ["draft", "cancelled", "voided"].includes(line.status));
  const mayRemoveDraft = can("restaurant", "orders.void") || can("restaurant", "approvals.approve");

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
              {outstandingPaidBill(data) ? (
                <span className="text-sm font-medium text-destructive">Payment outstanding</span>
              ) : null}
              {removableDraft && mayRemoveDraft ? (
                <Button variant="destructive" onClick={() => setRemoveOpen(true)}>
                  <Trash2 className="mr-2 size-4" /> Delete draft order
                </Button>
              ) : null}

              <DocumentPrintButton
                type="pos_receipt"
                id={data.id}
                label={fiscalAccepted ? "Fiscal Receipt PDF" : "Receipt PDF"}
                size="default"
              />

              {fiscalEligible && fiscalAccepted ? (
                <>
                  <span className="text-xs text-muted-foreground">
                    KRA accepted
                    {fiscalStatus.data?.kra_reference
                      ? ` · ${fiscalStatus.data.kra_reference}`
                      : ""}
                  </span>

                </>
              ) : fiscalEligible && fiscalPending ? (
                <span className="text-xs text-muted-foreground">
                  Fiscalisation pending
                </span>
              ) : fiscalEligible ? (
                <FileWithKraButton
                  posOrderId={data.id}
                  label={fiscalFailed ? "Retry fiscalisation" : "File with KRA"}
                  size="default"
                />
              ) : null}

              {receiptPrintState.isError ? (
                <Button size="sm" variant="outline" onClick={() => void receiptPrintState.refetch()}>
                  Reload receipt print status
                </Button>
              ) : receiptPrintState.data && !hasCompletedReceiptPrint ? (
                <SendToPrinterButton
                  type="pos_receipt"
                  id={data.id}
                  documentNumber={data.order_number}
                  role="restaurant"
                  branchId={data.branch_id}
                  existingJobId={receiptPrintState.data.inProgressId}
                  label={receiptPrintState.data.inProgressId ? "Track receipt print" : "Send to receipt printer"}
                />
              ) : !receiptPrintState.isLoading &&
                hasCompletedReceiptPrint &&
                (canReprintReceipt || receiptPrintState.data?.inProgressId) ? (
                <SendToPrinterButton
                  type="pos_receipt"
                  id={data.id}
                  documentNumber={data.order_number}
                  role="restaurant"
                  branchId={data.branch_id}
                  existingJobId={receiptPrintState.data?.inProgressId ?? null}
                  label={receiptPrintState.data?.inProgressId ? "Track receipt print" : "Reprint receipt"}
                />
              ) : null}
            </>
          ) : null
        }
      />
      {data ? <PosRefundPanel key={data.id} orderId={data.id}/> : null}

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
                      <StockAwareMenuItem
                        key={m.id}
                        name={m.name}
                        onUnavailable={(reason) => setStockIssue(`${m.name}: ${reason}`)}
                        disabled={
                          !can("pos", "orders.create") ||
                          m.publish_status !== "published"
                        }
                        unavailableReason={
                          m.station_missing
                            ? "This item has no production station, so the kitchen would never receive it."
                            : m.availability !== "available" ? stockOut.data?.get(m.id) || "This item is marked out of stock for this property." : null
                        }
                        checkStock={async () => {
                          if (!data.branch_id) return "This bill has no property assigned, so stock cannot be verified.";
                          const fresh = await stockOut.refetch();
                          if (fresh.isError) throw fresh.error;
                          return fresh.data?.get(m.id) ?? null;
                        }}
                        onAvailable={() => {
                          setStockIssue(null);
                          setPendingItem({
                            id: m.id,
                            name: m.name,
                            base_price: m.base_price,
                            tax_rate: m.tax_rate ?? 0,
                            station_id: m.station_id,
                          });
                        }}
                      >
                        <p className="text-sm font-semibold">{m.name}</p>
                        <p className="text-xs text-muted-foreground">{money(m.base_price)}</p>
                        {m.availability !== "available" ? (
                          <StatusPill tone="warning">{titleCase(m.availability)}</StatusPill>
                        ) : null}
                        {m.station_missing ? (
                          <StatusPill tone="destructive">No production station</StatusPill>
                        ) : null}
                        {stockOut.data?.has(m.id) && m.availability === "available" ? (
                          <StatusPill tone="destructive">
                            {stockOut.data.get(m.id)?.startsWith("Out of stock:") ? "Out of stock" : "Stock check"}
                          </StatusPill>
                        ) : null}
                      </StockAwareMenuItem>
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
                }, { onSuccess: () => setPendingItem(null) });
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
                    onClick={() => { setStockIssue(null); send.mutate(data.id); }}
                  >
                    <Send className="mr-2 size-4" /> Send{" "}
                    {unsent.length ? `(${unsent.length})` : ""}
                  </Button>
                }
              >
                {stockIssue ? (
                  <div role="alert" className="mb-3 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
                    <p className="text-sm font-semibold text-destructive">{stockIssue}</p>
                    <Button variant="ghost" size="sm" onClick={() => setStockIssue(null)}>Dismiss</Button>
                  </div>
                ) : null}
                {Number(data.paid_total ?? 0) > 0 && unsent.length > 0 ? (
                  <p role="status" className="mb-3 text-sm text-muted-foreground">Payment received. Draft items still need Send; sending checks stock again.</p>
                ) : null}
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
                          <SavedItemTaxes snapshot={(l as typeof l & { sales_tax_snapshot?: unknown }).sales_tax_snapshot} />
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
                    <dt className="text-muted-foreground">Items (including applicable tax)</dt>
                    <dd>{money(data.subtotal)}</dd>
                  </div>
                  {Number(data.discount_total ?? 0) > 0 ? (
                    <div className="flex justify-between">
                      <dt className="text-muted-foreground">Discount</dt>
                      <dd>- {money(data.discount_total)}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Tax on this bill</dt>
                    <dd>{money(data.tax_total)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Service charge (added)</dt>
                    <dd>{money(data.service_charge_total)}</dd>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <dt>Total</dt>
                    <dd>{money(data.grand_total)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Paid at POS</dt>
                    <dd>{money(data.paid_total)}</dd>
                  </div>
                  <div className="flex justify-between font-semibold">
                    <dt>Amount due at POS</dt>
                    <dd>{roomTransfer.amountDue === null ? "Review money evidence" : money(balance)}</dd>
                  </div>
                  {roomTransfer.transferred && !roomTransfer.overlap ? <div className="flex justify-between">
                    <dt className="text-muted-foreground">Balance transferred to guest folio</dt><dd>{money(roomTransfer.transferredBalance ?? 0)}</dd>
                  </div> : null}
                  {roomTransfer.credit > 0 ? <div className="flex justify-between"><dt>POS credit / overpayment</dt><dd>{money(roomTransfer.credit)}</dd></div> : null}
                </dl>
                <p className="mt-2 text-xs text-muted-foreground">The tax shown in the bill summary is already reflected in the total. Item tax amounts are shown before bill discounts.</p>

                <div className="mt-4 grid gap-2">
                  <Button
                    disabled={!can("pos", "orders.edit") || !roomTransfer.canCollect}
                    onClick={() => setPayOpen(true)}
                  >
                    Take payment
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!can("pos", "orders.approve") || !canTransferRoom}
                    onClick={() => setRoomOpen(true)}
                  >
                    <BedDouble className="mr-2 size-4" /> Charge to room
                  </Button>
                  {can("pos", "orders.edit") && roomTransfer.canCollect ? (
                    <MpesaPromptDialog
                      sourceModule="pos_order"
                      sourceRecordId={data.id}
                      balance={balance}
                      description={`Bill ${data.order_number ?? data.id.slice(0, 8)}`}
                      onSettled={() => void order.refetch()}
                    />
                  ) : null}

                  {data.status !== "closed" && !roomTransfer.transferred && roomTransfer.amountDue !== null && Number(data.grand_total) > 0 ? (
                    <Button
                      variant="ghost"
                      disabled={reconcile.isPending}
                      onClick={() => reconcile.mutate(data.id)}
                    >
                      Reconcile &amp; close if eligible
                    </Button>
                  ) : null}
                  {roomTransferReason ? <p className="text-xs text-muted-foreground" role={roomTransfer.overlap ? "alert" : undefined}>{roomTransferReason}</p> : null}
                  {openItems > 0 && !roomTransfer.transferred && roomTransfer.amountDue !== null && balance <= 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {openItems} item(s) are still in preparation. The bill closes once they are
                      served, cancelled or voided.
                    </p>
                  ) : null}
                </div>
              </SectionCard>

              <SectionCard title="Payments"
                description="Saved payment attempts and their receipt reviews. A submitted receipt remains unconfirmed until approved.">
                {receiptReviews.isError ? (
                  <p role="alert" className="mb-3 text-sm text-destructive">
                    Receipt-review status could not be refreshed. Check the existing review before resubmitting.
                  </p>
                ) : null}
                {pendingCash.isError ? <p role="alert" className="mb-3 text-sm text-destructive">
                  Cash requests could not be refreshed. Check with the cashier before sending another request.
                </p> : null}
                {(pendingCash.data ?? []).map((request) => (
                  <p key={request.id} className="mb-3 rounded-xl border p-3 text-sm">
                    Cash · {money(request.amount)} · Awaiting cashier confirmation
                  </p>
                ))}
                {(data.pos_payments ?? []).length === 0 ? (
                  pendingCash.data?.length ? null : <p className="text-sm text-muted-foreground">No payments recorded yet.</p>
                ) : (
                  <ul className="space-y-3">
                    {data.pos_payments.map((p) => {
                      const review = receiptReviews.data?.find((r) => r.payment_id === p.id);
                      const reviewing = review && [
                        "pending_approval", "approved_pending_execution", "executing", "execution_failed",
                      ].includes(review.status);
                      const pending = ["pending", "initiated", "failed"].includes(p.status);
                      return (
                        <li key={p.id} className="rounded-xl border border-border p-3">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-sm font-medium">{titleCase(p.method)} · {money(p.amount)}</p>
                              {p.external_reference ? (
                                <p className="break-all text-xs text-muted-foreground">{p.external_reference}</p>
                              ) : null}
                              {p.verification_note ? (
                                <p className="mt-1 text-xs text-muted-foreground">{p.verification_note}</p>
                              ) : null}
                              {review ? (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  Receipt {review.receipt}: {titleCase(review.status.replaceAll("_", " "))}
                                </p>
                              ) : null}
                              {review?.execution_error ? (
                                <p className="mt-1 text-xs text-destructive">{review.execution_error}</p>
                              ) : null}
                            </div>
                            <StatusPill tone={p.status === "confirmed" ? "success" : p.status === "failed" ? "destructive" : "warning"}>
                              {p.provider_status === "manager-reviewed" ? "Cashier / supervisor reviewed" : titleCase(p.status)}
                            </StatusPill>
                          </div>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {p.method === "mpesa" && can("pos", "payments", "process")
                              && (pending || p.provider_status === "manager-reviewed") ? (
                              <MpesaPromptDialog sourceModule="pos_order" sourceRecordId={data.id}
                                paymentId={p.id} recoveryOnly triggerLabel="Check Safaricom"
                                balance={balance} initialAmount={Number(p.amount)}
                                onSettled={() => void order.refetch()} />
                            ) : null}
                            {p.method === "mpesa" && pending && canSubmitReceipt && !reviewing && !roomTransfer.transferred ? (
                              <Button size="sm" variant="outline" onClick={() => {
                                setConfirmNote(""); setConfirmReceipt("");
                                setConfirmPayment({ id: p.id, amount: Number(p.amount), method: p.method });
                              }}>
                                Submit receipt for review
                              </Button>
                            ) : null}
                            {p.method !== "mpesa" && canManualConfirm && !roomTransfer.transferred
                              && ["pending", "initiated"].includes(p.status) ? (
                              <Button size="sm" variant="outline" onClick={() => {
                                setConfirmNote(""); setConfirmReceipt("");
                                setConfirmPayment({ id: p.id, amount: Number(p.amount), method: p.method });
                              }}>Confirm</Button>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </SectionCard>
            </div>
          </div>
        ) : null}
      </QueryState>

      {data ? (
        <>
          <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete draft order {data.order_number}?</DialogTitle>
                <DialogDescription>
                  Remove this unused draft from active orders. Its records and audit history are
                  retained. Orders with payment, production or stock history require the controlled
                  void or refund workflow.
                </DialogDescription>
              </DialogHeader>
              <Label htmlFor="draft-removal-reason">Removal reason</Label>
              <Textarea id="draft-removal-reason" value={removeReason} maxLength={500}
                onChange={event => setRemoveReason(event.target.value)} />
              <DialogFooter>
                <Button variant="outline" onClick={() => setRemoveOpen(false)}>Keep order</Button>
                <Button variant="destructive" disabled={!removableDraft || !mayRemoveDraft || removeReason.trim().length < 3 || removeDraftOrder.isPending}
                  onClick={() => removeDraftOrder.mutate({orderId: data.id, reason: removeReason}, {
                    onSuccess: () => { setRemoveOpen(false); void navigate({to: "/pos/orders"}); },
                  })}>
                  Delete draft order
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <PaymentDialog
            open={payOpen && roomTransfer.canCollect}
            onOpenChange={setPayOpen}
            orderId={data.id}
            branchId={data.branch_id}
            balance={balance}
            shiftId={shift.data?.id ?? null}
          />
          <RoomChargeDialog
            open={roomOpen && canTransferRoom}
            onOpenChange={setRoomOpen}
            orderId={data.id}
            branchId={data.branch_id}
            balance={balance}
            eligible={canTransferRoom}
            eligibilityReason={roomTransferReason}
          />
          <Dialog
            open={Boolean(confirmPayment) && !roomTransfer.transferred && (confirmPayment?.method === "mpesa" ? canSubmitReceipt : canManualConfirm)}
            onOpenChange={(open) => {
              if (!open) {
                setConfirmPayment(null); setConfirmNote(""); setConfirmReceipt("");
              }
            }}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {confirmPayment?.method === "mpesa" ? "Submit M-Pesa receipt" : "Confirm payment manually"}
                </DialogTitle>
                <DialogDescription>
                  {confirmPayment ? `${titleCase(confirmPayment.method)} · ${money(confirmPayment.amount)}. ` : ""}
                  {confirmPayment?.method === "mpesa"
                    ? "Enter the actual receipt and evidence for the cashier or authorized supervisor to check. Submission does not confirm money or send another prompt."
                    : "Confirm only after verifying that the money was received. Your verification is recorded."}
                </DialogDescription>
              </DialogHeader>
              {confirmPayment?.method === "mpesa" ? (
                <div className="grid gap-2">
                  <Label htmlFor="confirm-receipt">Safaricom receipt code</Label>
                  <Input id="confirm-receipt" value={confirmReceipt}
                    maxLength={16} autoCapitalize="characters" autoComplete="off"
                    onChange={(e) => setConfirmReceipt(e.target.value.toUpperCase())} />
                </div>
              ) : null}
              <div className="grid gap-2">
                <Label htmlFor="confirm-note">
                  {confirmPayment?.method === "mpesa" ? "Money evidence for review" : "Verification note"}
                </Label>
                <Textarea id="confirm-note" value={confirmNote} maxLength={1500}
                  onChange={(e) => setConfirmNote(e.target.value)}
                  placeholder="Describe the receiving-account evidence to check." />
              </div>
              <DialogFooter>
                <Button
                  disabled={confirmPayment?.method === "mpesa"
                    ? !canSubmitReceipt || !/^[A-Z0-9]{8,16}$/.test(confirmReceipt.trim())
                      || confirmNote.trim().length < 10 || submitReceipt.isPending
                    : !canManualConfirm || !confirmNote.trim() || confirmManual.isPending}
                  onClick={() => {
                    if (!confirmPayment) return;
                    const close = () => {
                      setConfirmPayment(null); setConfirmNote(""); setConfirmReceipt("");
                    };
                    if (confirmPayment.method === "mpesa") {
                      if (!canSubmitReceipt) return;
                      submitReceipt.mutate({
                        paymentId: confirmPayment.id,
                        receipt: confirmReceipt, evidence: confirmNote,
                      }, { onSuccess: close });
                    } else {
                      if (!canManualConfirm) return;
                      confirmManual.mutate({
                        paymentId: confirmPayment.id, note: confirmNote.trim(),
                      }, { onSuccess: close });
                    }
                  }}>
                  {confirmPayment?.method === "mpesa" ? "Submit for cashier review" : "Confirm payment"}
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
                  disabled={!voidReason.trim() || requestVoid.isPending}
                  onClick={async () => {
                    if (!voidItem || requestVoid.isPending) return;
                    try {
                    await requestVoid.mutateAsync({
                      orderId: data.id,
                      orderItemId: voidItem.id,
                      kind: "item",
                      amount: voidItem.total,
                      reason: voidReason,
                      preparationStatus: voidItem.status,
                    });
                    setVoidReason("");
                    setVoidItem(null);
                    } catch { /* Keep the reason and item visible for correction. */ }
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

function RoomChargeDialog({
  open,
  onOpenChange,
  orderId,
  branchId,
  balance,
  eligible,
  eligibilityReason,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orderId: string;
  branchId: string | null;
  balance: number;
  eligible: boolean;
  eligibilityReason: string | null;
}) {
  const stays = useCheckedInStays(branchId);
  const [stayId, setStayId] = useState<string>("");
  const folio = useOpenFolioForStay(stayId || undefined);
  const post = usePostRoomCharge();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Charge to guest room</DialogTitle>
          <DialogDescription>
            Post the sale to a checked-in guest’s open folio and apply any confirmed POS receipts.
            The amount added to the guest’s balance is {money(balance)}.
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
          {!eligible && eligibilityReason ? <p role="alert" className="text-sm text-destructive">{eligibilityReason}</p> : null}
          <Button
            disabled={!eligible || !folio.data || post.isPending}
            onClick={() =>
              eligible && post.mutate(
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
