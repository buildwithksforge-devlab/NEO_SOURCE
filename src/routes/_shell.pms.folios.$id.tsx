import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Receipt } from "lucide-react";
import {
  Atomic,
  PageHeader,
  ResponsiveRowActions,
  SectionCard,
  StatusPill,
  TableScroll,
} from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, FolioStatusBadge, PmsGuard, QueryState } from "@/components/pms/PmsShared";
import {
  FOLIO_CATEGORIES,
  formatDateTime,
  moneyWithCode as money,
  titleCase,
} from "@/lib/pms";
import {
  useFolio,
  useFolioLines,
  useFolioPayments,
  useOpenFolios,
  usePostFolioCharge,
  useReopenFolio,
  useReverseFolioLine,
  useTransferFolioLine,
} from "@/lib/frontdesk-ops";
import { useCloseFolio } from "@/lib/pms-data";
import { useBranchScope } from "@/lib/branches";
import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { FolioStatementBody } from "@/components/pms/FolioStatementDialog";
import {
  FolioIdentityFields,
  FolioTraceDrawer,
} from "@/components/pms/FolioIdentitySummary";
import { deriveFolioIdentity, type FolioIdentity } from "@/lib/folio-identity";
import { RecordBreadcrumbs, RelatedRecords } from "@/components/common/RecordBreadcrumbs";
import { useFolioProjection } from "@/lib/payment-lifecycle";

export const Route = createFileRoute("/_shell/pms/folios/$id")({
  head: () => ({
    meta: [
      { title: "Folio Detail — NEØ" },
      {
        name: "description",
        content:
          "Charges, payments, transfers, allowances and reversals on a single guest, group, company or incidental folio.",
      },
      { property: "og:title", content: "Folio Detail — NEØ" },
      {
        property: "og:description",
        content:
          "Charges, payments, transfers, allowances and reversals on a single guest, group, company or incidental folio.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="folios.view">
      <FolioDetailPage />
    </PmsGuard>
  ),
});

type LineRow = {
  id: string;
  description: string;
  category: string;
  quantity: number;
  unit_price: number;
  gross_amount: number;
  net_amount: number;
  posting_date: string;
  source_module: string;
  status: string;
};

function FolioDetailPage() {
  const { id } = Route.useParams();
  const folio = useFolio(id);
  const lines = useFolioLines(id);
  const payments = useFolioPayments(id);
  const closeFolio = useCloseFolio();
  const [charging, setCharging] = useState(false);
  const [transferLine, setTransferLine] = useState<LineRow | null>(null);
  const [reverseLine, setReverseLine] = useState<LineRow | null>(null);
  const [reopening, setReopening] = useState(false);

  const f = folio.data as Record<string, any> | null | undefined;
  const currency = (f?.["currency"] as string) ?? "KES";
  const closed = f ? ["closed", "settled", "voided"].includes(String(f["status"])) : false;
  // A folio permanently knows who and what it belongs to: the guest, the
  // company or group it bills to, and the reservation it settles. These are
  // separate facts — collapsing them loses receivables and CRM identity.
  const guestName = (f?.["customers"]?.full_name as string | undefined) ?? "—";
  const guestEmail = (f?.["customers"]?.email as string | undefined) ?? "";
  const companyName =
    (f?.["corporate_accounts"]?.legal_name as string | undefined) ??
    (f?.["group_bookings"]?.name as string | undefined) ??
    "—";
  const billingInstructions = (f?.["billing_instructions"] as string | undefined) || "—";
  const account = guestName !== "—" ? guestName : companyName;


  // Property and stay dates come from the folio's own branch and reservation —
  // never from the currently selected property.
  const { branches } = useBranchScope();
  const propertyName =
    branches.find((b) => b.id === (f?.["branch_id"] as string | undefined))?.name ?? "—";
  const arrival = f?.["reservations"]?.arrival_date as string | undefined;
  const departure = f?.["reservations"]?.departure_date as string | undefined;
  const stay = arrival || departure ? `${arrival ?? "—"} → ${departure ?? "—"}` : "—";

  const lineRows = (lines.data ?? []) as Array<Record<string, any>>;
  const postedRows = lineRows.filter((l) => String(l["status"] ?? "posted") === "posted");
  const postedLineCount = postedRows.length;
  const discountTotal = Number(f?.["total_discounts"] ?? 0);

  // The bill itself is never re-added here. `neo_folio_projection` is the one
  // canonical answer to net, tax, gross, collected and outstanding, so this
  // screen cannot disagree with the register, the cashbook or the ledger.
  const projection = useFolioProjection(id);
  const proj = projection.data?.found ? projection.data : null;
  const netCharges = proj?.netRevenue ?? 0;
  const taxTotal = proj?.tax ?? 0;
  const serviceTotal = proj?.serviceCharge ?? 0;
  const totalBilled = proj?.grossObligation ?? 0;
  const totalCollected = proj?.collected ?? 0;
  const outstanding = proj?.outstanding ?? 0;


  const reservation = f?.["reservations"] as Record<string, unknown> | undefined;
  const reservationId = reservation?.["id"] ? String(reservation["id"]) : null;
  const roomNumber = (reservation?.["rooms"] as Record<string, unknown> | undefined)?.[
    "room_number"
  ];

  return (
    <div>
      {/* Where this record sits, and what it is attached to. Every step is a
          real destination, so no identifier on this page is a dead end. */}
      <RecordBreadcrumbs
        className="mb-2"
        trail={[
          { label: "Front Office", to: "/pms" },
          { label: "Folios", to: "/pms/folios" },
          { label: account },
          { label: f ? `Folio ${String(f["folio_number"] ?? "")}` : "Folio" },
        ]}
      />
      <PageHeader
        eyebrow="Front Office"
        title={f ? `Folio ${f["folio_number"]}` : "Folio"}
        description={`${titleCase(f?.["folio_type"] ?? "")} folio for ${account}. Every posting keeps its source module, source record and actor — corrections are made by transfer, allowance or reversal, never deletion.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <Link to="/pms/folios">
                <ArrowLeft className="mr-2 size-4" /> All folios
              </Link>
            </Button>
            <FolioTraceDrawer folioId={f ? String(f["id"]) : null} />
            <DocumentPrintButton
              type="folio_statement"
              id={f ? String(f["id"]) : null}
              label="Print statement"
              size="default"
            />
            {closed ? (
              <Button variant="outline" onClick={() => setReopening(true)}>
                Reopen folio
              </Button>
            ) : (
              <>
                {Math.abs(Number(f?.["balance"] ?? 0)) <= 0.01 ? (
                  <Button
                    variant="outline"
                    disabled={closeFolio.isPending}
                    onClick={() =>
                      closeFolio.mutate({
                        folio: id,
                        reason: "Zero-balance folio closed from folio detail",
                      })
                    }
                  >
                    {closeFolio.isPending ? "Closing…" : "Close folio"}
                  </Button>
                ) : null}
                <Button onClick={() => setCharging(true)}>Post charge</Button>
              </>
            )}
          </div>
        }
      />

      {f ? (
        <RelatedRecords
          className="mb-4"
          records={[
            {
              kind: "Reservation",
              label: reservation?.["confirmation_number"]
                ? String(reservation["confirmation_number"])
                : "",
              to: reservationId ? `/pms/reservations/${reservationId}` : undefined,
            },
            { kind: "Room", label: roomNumber ? String(roomNumber) : "", to: "/pms/rooms" },
            { kind: "Guest", label: account, to: "/guests" },
          ]}
        />
      ) : null}

      <QueryState
        isLoading={folio.isLoading || projection.isLoading}
        error={folio.error ?? projection.error}
        isEmpty={!f || !proj}
        empty={
          <EmptyState
            icon={Receipt}
            title="Folio not found"
            description="It may have been closed under a different property, or you may not have access to it."
          />
        }
      >
        {f ? (
          <>
            {/* Statement head — reads like the printed folio statement it produces. */}
            <SectionCard
              title={`Folio ${String(f["folio_number"] ?? "")}`}
              description="Guest, stay and settlement position as held on the canonical record."
              className="mb-4"
              actions={<FolioStatusBadge status={String(f["status"])} />}
            >
              <div className="grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
                <FolioIdentityFields
                  identity={
                    deriveFolioIdentity(f as Record<string, unknown>, propertyName) as FolioIdentity
                  }
                />

                {/* The full arithmetic is shown, so charges, service, tax,
                    payments and balance can never appear to contradict each
                    other: charges are held net of tax and service on the
                    canonical record. */}
                <div className="surface-inset grid grid-cols-1 gap-2 rounded-xl p-4">
                  <StatementRow
                    label="Net charges"
                    value={money(netCharges, currency)}
                  />
                  {discountTotal > 0 ? (
                    <StatementRow label="Discounts" value={`- ${money(discountTotal, currency)}`} />
                  ) : null}
                  <StatementRow label="Service charge" value={money(serviceTotal, currency)} />

                  <StatementRow label="VAT" value={money(taxTotal, currency)} />
                  <StatementRow label="Gross billed" value={money(totalBilled, currency)} />
                  <StatementRow label="Collected" value={money(totalCollected, currency)} />
                  {Number(f["total_refunds"] ?? 0) > 0 ? (
                    <StatementRow label="Refunds" value={money(f["total_refunds"], currency)} />
                  ) : null}
                  <div className="mt-1 flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary-soft/50 px-3 py-2">
                    <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                      {outstanding < 0 ? "Refund due" : "Outstanding"}
                    </span>
                    <span className="neo-atomic text-base font-semibold text-primary">
                      {money(outstanding, currency)}
                    </span>
                  </div>
                  <p className="pt-1 text-xs text-muted-foreground">
                    Posting status: {titleCase(String(f["status"] ?? ""))} ·{" "}
                    {postedLineCount} posted {postedLineCount === 1 ? "line" : "lines"}
                  </p>
                </div>
              </div>
            </SectionCard>

            <Tabs defaultValue="charges">
              <TabsList>
                <TabsTrigger value="charges">Charges</TabsTrigger>
                <TabsTrigger value="payments">Payments & deposits</TabsTrigger>
                <TabsTrigger value="routing">Routing & attribution</TabsTrigger>
                <TabsTrigger value="statement">Statement preview</TabsTrigger>
              </TabsList>

              <TabsContent value="statement" className="mt-4">
                <SectionCard
                  title="Folio statement"
                  description="Exactly what prints, paginated into A4 sheets with repeating column headers. Pinch or use the zoom controls on a phone; nothing is clipped outside the app."
                >
                  <FolioStatementBody folioId={id} />
                </SectionCard>
              </TabsContent>

              <TabsContent value="charges" className="mt-4">
                <SectionCard
                  title="Posted charges"
                  description="Reversals appear as new negative postings. Nothing is removed from the record."
                >
                  <QueryState
                    isLoading={lines.isLoading}
                    error={lines.error}
                    isEmpty={(lines.data ?? []).length === 0}
                    empty={
                      <EmptyState
                        icon={Receipt}
                        title="No charges posted"
                        description="Room, restaurant, laundry, transport and event charges appear here as their source modules post them."
                      />
                    }
                  >
                    <TableScroll>
                      <Table className="neo-list-rows">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="neo-sticky-col">Posted</TableHead>
                            <TableHead>Description</TableHead>
                            <TableHead>Category</TableHead>
                            <TableHead>Source</TableHead>
                            <TableHead className="text-right">Qty</TableHead>
                            <TableHead className="text-right">Total</TableHead>
                            <TableHead />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {((lines.data ?? []) as unknown as LineRow[]).map((l) => (
                            <TableRow key={l.id}>
                              <TableCell className="neo-sticky-col whitespace-nowrap text-xs">
                                {formatDateTime(l.posting_date)}
                              </TableCell>
                              <TableCell className="min-w-[12rem]">
                                <span
                                  className="neo-line-1 max-w-[22rem]"
                                  title={l.description || "—"}
                                >
                                  {l.description || "—"}
                                </span>
                              </TableCell>
                              <TableCell className="whitespace-nowrap">
                                {titleCase(l.category)}
                              </TableCell>
                              <TableCell className="whitespace-nowrap font-mono text-xs">
                                {l.source_module || "manual"}
                              </TableCell>
                              <TableCell className="text-right">
                                <Atomic>{l.quantity}</Atomic>
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                <Atomic>{money(l.gross_amount, currency)}</Atomic>
                              </TableCell>
                              <TableCell className="text-right">
                                {closed || Number(l.gross_amount ?? 0) < 0 ? null : (
                                  <ResponsiveRowActions
                                    secondary={[
                                      { label: "Transfer", onSelect: () => setTransferLine(l) },
                                      { label: "Reverse", onSelect: () => setReverseLine(l) },
                                    ]}
                                  />
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableScroll>
                  </QueryState>
                </SectionCard>
              </TabsContent>

              <TabsContent value="payments" className="mt-4">
                <SectionCard
                  title="Payments, deposits and refunds"
                  description="Settlement records linked to this folio. Confirmed payments are reversed by credit note, never edited."
                >
                  <QueryState
                    isLoading={payments.isLoading}
                    error={payments.error}
                    isEmpty={(payments.data ?? []).length === 0}
                    empty={
                      <EmptyState
                        icon={Receipt}
                        title="No payments yet"
                        description="Deposits and settlements recorded against this folio will appear here."
                      />
                    }
                  >
                    <TableScroll>
                      <Table className="neo-list-rows">
                        <TableHeader>
                          <TableRow>
                            <TableHead className="neo-sticky-col">Received</TableHead>
                            <TableHead>Method</TableHead>
                            <TableHead>Reference</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead className="text-right">Amount</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {((payments.data ?? []) as Record<string, any>[]).map((p) => (
                            <TableRow key={String(p["id"])}>
                              <TableCell className="neo-sticky-col whitespace-nowrap text-xs">
                                {formatDateTime(p["paid_at"] ?? p["created_at"])}
                              </TableCell>
                              <TableCell>
                                {titleCase(
                                  String(p["method"] ?? p["payment_method"] ?? "—"),
                                )}
                              </TableCell>
                              <TableCell className="font-mono text-xs">
                                {p["external_reference"] ??
                                  p["receipt_number"] ??
                                  p["reference"] ??
                                  p["transaction_reference"] ??
                                  "—"}
                              </TableCell>
                              <TableCell>
                                <StatusPill tone="info">
                                  {titleCase(String(p["status"] ?? "recorded"))}
                                </StatusPill>
                              </TableCell>
                              <TableCell className="text-right font-medium">
                                <Atomic>{money(p["amount"], currency)}</Atomic>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableScroll>
                  </QueryState>
                </SectionCard>
              </TabsContent>

              <TabsContent value="routing" className="mt-4">
                <SectionCard
                  title="Folio attribution"
                  description="Who this folio belongs to and which records it is bound to."
                >
                  <dl className="grid gap-4 sm:grid-cols-2">
                    <Detail label="Folio type" value={titleCase(f["folio_type"])} />
                    <Detail label="Account" value={account} />
                    <Detail
                      label="Reservation"
                      value={f["reservations"]?.confirmation_number ?? "—"}
                    />
                    <Detail label="Room" value={f["reservations"]?.rooms?.room_number ?? "—"} />
                    <Detail label="Opened" value={formatDateTime(f["opened_at"])} />
                    <Detail label="Closed" value={formatDateTime(f["closed_at"]) || "—"} />
                    <Detail label="Currency" value={currency} />
                    <Detail label="Folio ID" value={String(f["id"])} mono />
                  </dl>
                </SectionCard>
              </TabsContent>
            </Tabs>
          </>
        ) : null}
      </QueryState>

      <PostChargeDialog folioId={id} open={charging} onClose={() => setCharging(false)} />
      <TransferDialog line={transferLine} folioId={id} onClose={() => setTransferLine(null)} />
      <ReverseDialog line={reverseLine} onClose={() => setReverseLine(null)} />
      <ReopenDialog folioId={id} open={reopening} onClose={() => setReopening(false)} />
    </div>
  );
}

function StatementRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="neo-atomic font-medium">{value}</span>
    </div>
  );
}

function Detail({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-1 font-mono text-xs" : "mt-1 text-sm font-medium"}>
        {value || "—"}
      </dd>
    </div>
  );
}

function PostChargeDialog({
  folioId,
  open,
  onClose,
}: {
  folioId: string;
  open: boolean;
  onClose: () => void;
}) {
  const post = usePostFolioCharge();
  const [category, setCategory] = useState(String(FOLIO_CATEGORIES[0]));
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [tax, setTax] = useState("0");
  const [serviceCharge, setServiceCharge] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [revenueCentre, setRevenueCentre] = useState("");

  const invalid =
    description.trim().length < 3 ||
    !unitPrice ||
    Number.isNaN(Number(unitPrice)) ||
    Number(quantity) <= 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Post a charge</DialogTitle>
          <DialogDescription>
            The posting carries its source module, actor and an idempotency key, so a repeated click
            cannot double-charge the guest.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FOLIO_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {titleCase(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="charge-desc">Description</Label>
            <Input
              id="charge-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field id="charge-qty" label="Quantity" value={quantity} onChange={setQuantity} />
            <Field id="charge-price" label="Unit price" value={unitPrice} onChange={setUnitPrice} />
            <Field id="charge-tax" label="Tax" value={tax} onChange={setTax} />
            <Field
              id="charge-svc"
              label="Service charge"
              value={serviceCharge}
              onChange={setServiceCharge}
            />
            <Field id="charge-disc" label="Discount" value={discount} onChange={setDiscount} />
            <Field
              id="charge-rc"
              label="Revenue centre"
              value={revenueCentre}
              onChange={setRevenueCentre}
              numeric={false}
            />
          </div>
          <Button
            disabled={invalid || post.isPending}
            onClick={() =>
              post.mutate(
                {
                  folio: folioId,
                  category,
                  description: description.trim(),
                  quantity: Number(quantity),
                  unitPrice: Number(unitPrice),
                  tax: Number(tax) || 0,
                  serviceCharge: Number(serviceCharge) || 0,
                  discount: Number(discount) || 0,
                  revenueCentre,
                },
                { onSuccess: onClose },
              )
            }
          >
            {post.isPending ? "Posting…" : "Post charge"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  numeric = true,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  numeric?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode={numeric ? "decimal" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function TransferDialog({
  line,
  folioId,
  onClose,
}: {
  line: LineRow | null;
  folioId: string;
  onClose: () => void;
}) {
  const transfer = useTransferFolioLine();
  const folios = useOpenFolios();
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const options = ((folios.data ?? []) as Record<string, any>[]).filter(
    (f) => String(f["id"]) !== folioId,
  );

  return (
    <Dialog open={Boolean(line)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Transfer charge</DialogTitle>
          <DialogDescription>
            The charge is reversed here and re-posted on the receiving folio, with both sides linked
            by one correlation key.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Receiving folio</Label>
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger>
                <SelectValue placeholder="Select an open folio" />
              </SelectTrigger>
              <SelectContent>
                {options.map((f) => (
                  <SelectItem key={String(f["id"])} value={String(f["id"])}>
                    {String(f["folio_number"])} —{" "}
                    {f["customers"]?.full_name ?? titleCase(String(f["folio_type"]))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="transfer-reason">Reason</Label>
            <Textarea
              id="transfer-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            disabled={!target || reason.trim().length < 3 || transfer.isPending}
            onClick={() =>
              transfer.mutate(
                { line: line!.id, target, reason: reason.trim() },
                { onSuccess: onClose },
              )
            }
          >
            {transfer.isPending ? "Transferring…" : "Transfer charge"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReverseDialog({ line, onClose }: { line: LineRow | null; onClose: () => void }) {
  const reverse = useReverseFolioLine();
  const [reason, setReason] = useState("");

  return (
    <Dialog open={Boolean(line)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse charge</DialogTitle>
          <DialogDescription>
            A contra posting is created against {line?.description ?? "this charge"}. The original
            stays on the folio for audit.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="reverse-reason">Reason (required)</Label>
            <Textarea
              id="reverse-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 5 || reverse.isPending}
            onClick={() =>
              reverse.mutate({ line: line!.id, reason: reason.trim() }, { onSuccess: onClose })
            }
          >
            {reverse.isPending ? "Reversing…" : "Post reversal"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ReopenDialog({
  folioId,
  open,
  onClose,
}: {
  folioId: string;
  open: boolean;
  onClose: () => void;
}) {
  const reopen = useReopenFolio();
  const [reason, setReason] = useState("");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen folio</DialogTitle>
          <DialogDescription>
            Closed folios cannot be edited directly. Reopening is recorded with your name, the time
            and the reason given.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="reopen-reason">Reason (required)</Label>
            <Textarea
              id="reopen-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <Button
            disabled={reason.trim().length < 5 || reopen.isPending}
            onClick={() =>
              reopen.mutate({ folio: folioId, reason: reason.trim() }, { onSuccess: onClose })
            }
          >
            {reopen.isPending ? "Reopening…" : "Reopen folio"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
