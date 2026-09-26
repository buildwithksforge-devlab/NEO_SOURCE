import { useMemo, useState } from "react";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { PageHeader, SectionCard, StatusPill, TableScroll } from "@/components/common/DataDisplay";
import { StockItemNotice } from "@/components/common/StockItemNotice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, PosGuard, QueryState } from "@/components/pos/PosShared";
import { useAuth } from "@/lib/auth";
import { titleCase } from "@/lib/pos";
import {
  num,
  str,
  useConfirmRequisitionReceipt,
  useDepartmentRequisitions,
  useRaiseRequisition,
  useStockItemOptions,
  type FnbRow,
  type RequisitionLineInput,
} from "@/lib/fnb";

export const Route = createFileRoute("/_shell/pos/requisitions")({
  head: () => ({
    meta: [
      { title: "F&B Stores Requisitions — NEØ" },
      {
        name: "description",
        content:
          "Raise Food & Beverage requisitions against Stores, follow approval and issue, and confirm what the department actually received.",
      },
      { property: "og:title", content: "F&B Stores Requisitions — NEØ" },
      {
        property: "og:description",
        content:
          "Restaurant and coffee station requisitions to Stores, with issue tracking and receipt confirmation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="requisitions.view" path="/pos/requisitions">
      <RequisitionsPage />
    </PosGuard>
  ),
});

const STATUS_TONE: Record<string, "success" | "warning" | "destructive" | "default"> = {
  received: "success",
  issued: "success",
  "partially-issued": "warning",
  "partially-received": "warning",
  "pending-supervisor": "warning",
  "pending-stores": "warning",
  rejected: "destructive",
};

const emptyLine = (): RequisitionLineInput => ({
  description: "",
  unit: "",
  quantity_requested: 0,
});

function RequisitionsPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState("all");
  const [open, setOpen] = useState(false);
  const [receiving, setReceiving] = useState<FnbRow | null>(null);

  const requisitions = useDepartmentRequisitions(status);
  const items = useStockItemOptions();
  const raise = useRaiseRequisition();
  const confirm = useConfirmRequisitionReceipt();

  const mayRaise = can("pos", "requisitions.create");
  const mayConfirm = can("pos", "requisitions.edit");

  const [lines, setLines] = useState<RequisitionLineInput[]>([emptyLine()]);
  const [requiredDate, setRequiredDate] = useState("");
  const [priority, setPriority] = useState("normal");
  const [reason, setReason] = useState("");
  const [received, setReceived] = useState<Record<string, string>>({});

  const rows = (requisitions.data ?? []) as FnbRow[];
  const options = (items.data ?? []) as FnbRow[];

  const pending = useMemo(
    () => rows.filter((r) => String(r["status"] ?? "").startsWith("pending")).length,
    [rows],
  );
  const awaitingReceipt = useMemo(
    () => rows.filter((r) => String(r["status"] ?? "").includes("issued")).length,
    [rows],
  );

  const setLine = (index: number, patch: Partial<RequisitionLineInput>) =>
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));

  const submit = () => {
    const payload = lines
      .filter(
        (l) => num(l.quantity_requested) > 0 && (l.stock_item_id || (l.description ?? "").trim()),
      )
      .map((l) => ({ ...l, quantity_requested: num(l.quantity_requested) }));
    raise.mutate(
      { lines: payload, requiredDate: requiredDate || null, priority, reason },
      {
        onSuccess: () => {
          setOpen(false);
          setLines([emptyLine()]);
          setRequiredDate("");
          setReason("");
        },
      },
    );
  };

  const confirmReceipt = () => {
    if (!receiving) return;
    const reqLines = (receiving["internal_requisition_lines"] as FnbRow[] | null) ?? [];
    const payload = reqLines
      .map((l) => ({
        id: String(l["id"]),
        quantity_received: Number(received[String(l["id"])] ?? 0) || 0,
      }))
      .filter((l) => l.quantity_received > 0);
    confirm.mutate(
      { requisitionId: String(receiving["id"]), lines: payload },
      {
        onSuccess: () => {
          setReceiving(null);
          setReceived({});
        },
      },
    );
  };

  return (
    <div>
      <PageHeader
        eyebrow="Food & Beverage"
        title="Stores Requisitions"
        description="The department requests stock; Stores approves and issues it. F&B never moves a Stores balance itself — the trail shows exactly what was requested, issued and received."
        actions={
          mayRaise ? (
            <Button onClick={() => setOpen(true)}>
              <Plus className="mr-2 h-4 w-4" /> New requisition
            </Button>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <SectionCard title="Awaiting approval">
          <p className="text-3xl font-semibold">{pending}</p>
        </SectionCard>
        <SectionCard title="Issued, awaiting receipt">
          <p className="text-3xl font-semibold">{awaitingReceipt}</p>
        </SectionCard>
        <SectionCard title="Requisitions on record">
          <p className="text-3xl font-semibold">{rows.length}</p>
        </SectionCard>
      </div>

      <SectionCard
        title="Requisition trail"
        actions={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[
                "all",
                "pending-supervisor",
                "pending-stores",
                "issued",
                "partially-issued",
                "received",
                "rejected",
              ].map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "all" ? "All statuses" : titleCase(s.replace(/-/g, " "))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        <QueryState
          isLoading={requisitions.isLoading}
          error={requisitions.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No requisitions yet"
              description="Raise a requisition when the restaurant or coffee station needs stock from Stores."
            />
          }
        >
          {
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Number</TableHead>
                    <TableHead>Raised</TableHead>
                    <TableHead>Required</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Lines</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const reqLines = (r["internal_requisition_lines"] as FnbRow[] | null) ?? [];
                    const state = String(r["status"] ?? "");
                    return (
                      <TableRow key={String(r["id"])}>
                        <TableCell className="font-medium">{str(r["request_number"])}</TableCell>
                        <TableCell>{str(r["request_date"])}</TableCell>
                        <TableCell>{str(r["required_date"])}</TableCell>
                        <TableCell>{titleCase(str(r["priority"], "normal"))}</TableCell>
                        <TableCell>{reqLines.length}</TableCell>
                        <TableCell>
                          <StatusPill tone={STATUS_TONE[state] ?? "default"}>
                            {titleCase(state.replace(/-/g, " "))}
                          </StatusPill>
                        </TableCell>
                        <TableCell className="text-right">
                          {mayConfirm && state.includes("issued") ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setReceiving(r);
                                setReceived({});
                              }}
                            >
                              Confirm receipt
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScroll>
          }
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New Stores requisition</DialogTitle>
            <DialogDescription>
              Stores reviews, approves and issues. Quantities issued update stock, never this
              screen.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <StockItemNotice query={items} />
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="required">Required by</Label>
                <NeoDatePicker
                  id="required"
                  value={requiredDate}
                  onChange={setRequiredDate}
                />
              </div>
              <div>
                <Label>Priority</Label>
                <Select value={priority} onValueChange={setPriority}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["low", "normal", "high", "urgent"].map((p) => (
                      <SelectItem key={p} value={p}>
                        {titleCase(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-3">
              {lines.map((line, index) => (
                <div key={index} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
                  <Select
                    value={line.stock_item_id ?? "free"}
                    onValueChange={(v) => {
                      const item = options.find((o) => String(o["id"]) === v);
                      setLine(index, {
                        stock_item_id: v === "free" ? null : v,
                        description: item ? str(item["name"], "") : (line.description ?? ""),
                        unit: item ? str(item["base_unit"], "") : (line.unit ?? ""),
                      });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Stock item" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="free">Not in Stores catalogue</SelectItem>
                      {options.map((o) => (
                        <SelectItem key={String(o["id"])} value={String(o["id"])}>
                          {str(o["name"])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="Description"
                    value={line.description ?? ""}
                    onChange={(e) => setLine(index, { description: e.target.value })}
                  />
                  <Input
                    type="number"
                    min="0"
                    placeholder="Qty"
                    value={line.quantity_requested === 0 ? "" : String(line.quantity_requested)}
                    onChange={(e) =>
                      setLine(index, { quantity_requested: Number(e.target.value) || 0 })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove line"
                    onClick={() =>
                      setLines((prev) =>
                        prev.length === 1 ? prev : prev.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLines((prev) => [...prev, emptyLine()])}
              >
                <Plus className="mr-2 h-4 w-4" /> Add line
              </Button>
            </div>

            <div>
              <Label htmlFor="reason">Reason</Label>
              <Textarea
                id="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What this stock is for"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={raise.isPending}>
              Send to Stores
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(receiving)}
        onOpenChange={(v) => {
          if (!v) setReceiving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm what was received</DialogTitle>
            <DialogDescription>
              Anything short of the issued quantity is recorded as a discrepancy for Stores to
              resolve.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {((receiving?.["internal_requisition_lines"] as FnbRow[] | null) ?? []).map((l) => (
              <div key={String(l["id"])} className="grid gap-2 sm:grid-cols-[2fr_1fr]">
                <div>
                  <p className="text-sm font-medium">{str(l["description"])}</p>
                  <p className="text-xs text-muted-foreground">
                    Issued {num(l["quantity_issued"])} {str(l["unit"], "")} · received so far{" "}
                    {num(l["quantity_received"])}
                  </p>
                </div>
                <Input
                  type="number"
                  min="0"
                  placeholder="Received now"
                  value={received[String(l["id"])] ?? ""}
                  onChange={(e) =>
                    setReceived((prev) => ({ ...prev, [String(l["id"])]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReceiving(null)}>
              Cancel
            </Button>
            <Button onClick={confirmReceipt} disabled={confirm.isPending}>
              Confirm receipt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
