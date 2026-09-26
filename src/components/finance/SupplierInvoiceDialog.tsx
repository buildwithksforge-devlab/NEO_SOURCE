import { useEffect, useMemo, useState } from "react";
import { FormDialog } from "@/components/common/FormDialog";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2 } from "lucide-react";
import { money, num } from "@/lib/procurement";
import {
  useCaptureSupplierInvoice,
  useInvoiceableOrders,
  useOrderReceipts,
  type InvoiceLineDraft,
} from "@/lib/procurement-data";

type Row = Record<string, unknown>;

type LineState = InvoiceLineDraft & { key: string };

const emptyLine = (): LineState => ({
  key: Math.random().toString(36).slice(2),
  description: "",
  stockItemId: null,
  quantity: 1,
  unitPrice: 0,
  taxAmount: 0,
  discountAmount: 0,
});

/**
 * Supplier invoice capture.
 *
 * This is the commercial document Finance validates before a payable exists.
 * It is deliberately a Finance surface — Stores receives goods, Finance accepts
 * the liability. Everything typed here is matched against the purchase order
 * and the accepted receipt quantities the moment it is saved.
 */
export function SupplierInvoiceDialog({
  open,
  onOpenChange,
  suppliers,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  suppliers: Row[];
}) {
  const capture = useCaptureSupplierInvoice();
  const orders = useInvoiceableOrders();

  const [supplierId, setSupplierId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [lines, setLines] = useState<LineState[]>([emptyLine()]);

  const receipts = useOrderReceipts(orderId || null);

  const orderRows = (orders.data ?? []) as Row[];
  const supplierOrders = useMemo(
    () =>
      orderRows.filter(
        (o) =>
          (!supplierId || String(o["supplier_id"]) === supplierId) &&
          !["cancelled", "voided"].includes(String(o["status"] ?? "")),
      ),
    [orderRows, supplierId],
  );

  const selectedOrder = orderRows.find((o) => String(o["id"]) === orderId) ?? null;

  // Choosing the order pre-fills what is still legitimately invoiceable, so the
  // person capturing the invoice sees the received position before typing.
  useEffect(() => {
    if (!selectedOrder) return;
    const orderLines = (selectedOrder["purchase_order_lines"] ?? []) as Row[];
    if (orderLines.length === 0) return;
    setLines(
      orderLines.map((l) => ({
        key: String(l["id"]),
        description: String(l["description"] ?? ""),
        stockItemId: (l["stock_item_id"] as string | null) ?? null,
        quantity: Math.max(num(l["accepted_quantity"]) - num(l["invoiced_quantity"]), 0),
        unitPrice: num(l["unit_price"]),
        taxAmount: 0,
        discountAmount: 0,
      })),
    );
  }, [selectedOrder]);

  const net = lines.reduce(
    (s, l) => s + num(l.quantity) * num(l.unitPrice) - num(l.discountAmount),
    0,
  );
  const tax = lines.reduce((s, l) => s + num(l.taxAmount), 0);

  const canSubmit =
    Boolean(supplierId) &&
    invoiceNumber.trim() !== "" &&
    lines.some((l) => num(l.quantity) > 0 && (l.description.trim() !== "" || l.stockItemId));

  const reset = () => {
    setSupplierId("");
    setOrderId("");
    setReceiptId("");
    setInvoiceNumber("");
    setDueDate("");
    setNotes("");
    setAllowDuplicate(false);
    setLines([emptyLine()]);
  };

  const update = (key: string, patch: Partial<LineState>) =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = () => {
    capture.mutate(
      {
        supplierId,
        invoiceNumber: invoiceNumber.trim(),
        invoiceDate,
        dueDate: dueDate || null,
        orderId: orderId || null,
        receiptId: receiptId || null,
        notes: notes.trim() || null,
        allowDuplicate,
        lines: lines
          .filter((l) => num(l.quantity) > 0)
          .map(({ key: _key, ...rest }) => rest),
      },
      {
        onSuccess: () => {
          reset();
          onOpenChange(false);
        },
      },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
      title="Capture supplier invoice"
      description="Record the supplier's commercial invoice. It is matched against the purchase order and the quantities actually accepted before any payable is raised."
      submitLabel="Capture and match"
      busyLabel="Matching…"
      canSubmit={canSubmit}
      busy={capture.isPending}
      onSubmit={submit}
      size="lg"
      footerNote="Capturing does not pay the supplier. A payable is only raised when the invoice is accepted."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="inv-supplier">Supplier</Label>
          <Select value={supplierId} onValueChange={setSupplierId}>
            <SelectTrigger id="inv-supplier">
              <SelectValue placeholder="Select a supplier" />
            </SelectTrigger>
            <SelectContent>
              {suppliers.map((s) => (
                <SelectItem key={String(s["id"])} value={String(s["id"])}>
                  {String(s["name"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="inv-number">Invoice number</Label>
          <Input
            id="inv-number"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            placeholder="Supplier's own reference"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="inv-date">Invoice date</Label>
          <NeoDatePicker id="inv-date" value={invoiceDate} onChange={setInvoiceDate} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="inv-due">Due date</Label>
          <NeoDatePicker id="inv-due" value={dueDate} onChange={setDueDate} />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="inv-order">Purchase order</Label>
          <Select value={orderId} onValueChange={setOrderId}>
            <SelectTrigger id="inv-order">
              <SelectValue placeholder="Link the authorising order" />
            </SelectTrigger>
            <SelectContent>
              {supplierOrders.map((o) => (
                <SelectItem key={String(o["id"])} value={String(o["id"])}>
                  {String(o["order_number"])} · {String(o["status"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            An invoice with no order is flagged and held for review.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="inv-grn">Goods received note</Label>
          <Select value={receiptId} onValueChange={setReceiptId} disabled={!orderId}>
            <SelectTrigger id="inv-grn">
              <SelectValue placeholder={orderId ? "Optional receipt reference" : "Select an order first"} />
            </SelectTrigger>
            <SelectContent>
              {(receipts.data ?? []).map((r) => (
                <SelectItem key={String(r["id"])} value={String(r["id"])}>
                  {String(r["grn_number"] ?? r["id"])} · {money(r["total_value"])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        <div className="flex items-center justify-between">
          <Label>Invoice lines</Label>
          <Button type="button" variant="outline" size="sm" onClick={() => setLines((p) => [...p, emptyLine()])}>
            Add line
          </Button>
        </div>

        {lines.map((l) => (
          <div key={l.key} className="grid gap-2 rounded-xl border border-border/60 p-3 sm:grid-cols-12">
            <div className="sm:col-span-5">
              <Label className="text-xs" htmlFor={`d-${l.key}`}>Description</Label>
              <Input
                id={`d-${l.key}`}
                value={l.description}
                onChange={(e) => update(l.key, { description: e.target.value })}
                placeholder="As printed on the invoice"
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs" htmlFor={`q-${l.key}`}>Quantity</Label>
              <Input
                id={`q-${l.key}`}
                inputMode="decimal"
                value={String(l.quantity)}
                onChange={(e) => update(l.key, { quantity: Number(e.target.value) })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs" htmlFor={`p-${l.key}`}>Unit price</Label>
              <Input
                id={`p-${l.key}`}
                inputMode="decimal"
                value={String(l.unitPrice)}
                onChange={(e) => update(l.key, { unitPrice: Number(e.target.value) })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label className="text-xs" htmlFor={`t-${l.key}`}>Tax</Label>
              <Input
                id={`t-${l.key}`}
                inputMode="decimal"
                value={String(l.taxAmount ?? 0)}
                onChange={(e) => update(l.key, { taxAmount: Number(e.target.value) })}
              />
            </div>
            <div className="flex items-end sm:col-span-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove line"
                onClick={() => setLines((p) => (p.length > 1 ? p.filter((x) => x.key !== l.key) : p))}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>
        ))}

        <div className="flex flex-wrap items-center justify-end gap-4 text-sm">
          <span className="text-muted-foreground">Net {money(net)}</span>
          <span className="text-muted-foreground">Tax {money(tax)}</span>
          <span className="font-semibold text-foreground">Total {money(net + tax)}</span>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="inv-notes">Notes</Label>
          <Textarea id="inv-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={allowDuplicate}
            onCheckedChange={(v) => setAllowDuplicate(v === true)}
            aria-label="Allow a repeated invoice number"
          />
          This supplier legitimately reused this invoice number — capture it anyway.
        </label>
      </div>
    </FormDialog>
  );
}
