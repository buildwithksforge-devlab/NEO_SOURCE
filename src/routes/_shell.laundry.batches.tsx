import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { WashingMachine } from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, OpsGuard, QueryState } from "@/components/operations/OpsShared";
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
import { useAuth } from "@/lib/auth";
import { useGuestLaundryOrders } from "@/lib/operations-data";
import { shortDateTime, titleCase } from "@/lib/operations";
import {
  LAUNDRY_BATCH_KINDS,
  laundryBatchTone,
  nextLaundryStatus,
  num,
  str,
  useAdvanceLaundryBatch,
  useAssignLaundryBatch,
  useCreateLaundryBatch,
  useLaundryBatchItems,
  useLaundryBatches,
  useLaundryStaffOptions,
  useLinenItems,
  useReturnLaundryBatch,
  type LaundryRow,
} from "@/lib/laundry-department";

export const Route = createFileRoute("/_shell/laundry/batches")({
  head: () => ({
    meta: [
      { title: "Linen Batches — Laundry — NEØ" },
      {
        name: "description",
        content:
          "Receive linen handovers, assign attendants, follow the wash conveyor and reconcile what comes back.",
      },
      { property: "og:title", content: "Linen Batches — Laundry — NEØ" },
      {
        property: "og:description",
        content: "Counted linen handovers with attendant assignment and return reconciliation.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <OpsGuard module="laundry" action="batches.view">
      <LaundryBatchesPage />
    </OpsGuard>
  ),
});

type NewLine = { linen_item_id: string; description: string; quantity: number };

function LaundryBatchesPage() {
  const { can } = useAuth();
  const mayManage = can("laundry", "batches.edit");
  const mayAssign = can("laundry", "batches.assign") || mayManage;

  const [filter, setFilter] = useState("open");
  const batches = useLaundryBatches(filter);
  const linen = useLinenItems();
  const staff = useLaundryStaffOptions();
  const createBatch = useCreateLaundryBatch();
  const assign = useAssignLaundryBatch();
  const advance = useAdvanceLaundryBatch();

  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("linen");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<NewLine[]>([
    { linen_item_id: "", description: "", quantity: 1 },
  ]);
  const [guestOrderId, setGuestOrderId] = useState("");
  const [returning, setReturning] = useState<LaundryRow | null>(null);
  const guestOrders = useGuestLaundryOrders();

  /** Guest garments are personal property, never hotel linen inventory. */
  const isGuestBatch = kind === "guest";
  const openGuestOrders = useMemo(
    () =>
      ((guestOrders.data ?? []) as LaundryRow[]).filter(
        (o) => !["delivered", "cancelled"].includes(str(o["status"], "")),
      ),
    [guestOrders.data],
  );
  const resetLines = () => {
    setLines([{ linen_item_id: "", description: "", quantity: 1 }]);
    setGuestOrderId("");
  };
  const pickGuestOrder = (id: string) => {
    setGuestOrderId(id);
    const order = openGuestOrders.find((o) => String(o["id"]) === id);
    const garments = (order?.["guest_laundry_items"] as LaundryRow[] | null) ?? [];
    setLines(
      garments.length > 0
        ? garments.map((g) => ({
            linen_item_id: "",
            description: str(g["description"], "Garment"),
            quantity: Math.max(1, num(g["quantity"]) || 1),
          }))
        : [{ linen_item_id: "", description: "", quantity: 1 }],
    );
  };
  const linesValid = isGuestBatch
    ? lines.some((l) => l.description.trim() && l.quantity > 0)
    : lines.some((l) => l.linen_item_id && l.quantity > 0);

  const rows = (batches.data ?? []) as LaundryRow[];
  const stats = useMemo(
    () => ({
      inProcess: rows.filter((r) => !["completed", "cancelled"].includes(str(r["status"], "")))
        .length,
      unassigned: rows.filter((r) => !r["attendant_id"] && str(r["status"], "") !== "completed")
        .length,
      ready: rows.filter((r) => str(r["status"], "") === "ready").length,
    }),
    [rows],
  );

  const staffName = (id: unknown) => {
    const match = (staff.data ?? []).find((s) => String(s["id"]) === String(id));
    return match ? str(match["full_name"], "Attendant") : null;
  };

  return (
    <div>
      <PageHeader
        eyebrow="Laundry"
        title="Linen batches"
        description="Linen arrives counted from Housekeeping, is assigned to an attendant, moves along the conveyor and is reconciled on the way back."
        actions={mayManage ? <Button onClick={() => setOpen(true)}>Receive linen</Button> : null}
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Batches in process"
          value={String(stats.inProcess)}
          hint="excluding completed"
        />
        <StatCard
          label="Unassigned"
          value={String(stats.unassigned)}
          hint="awaiting an attendant"
        />
        <StatCard
          label="Ready to hand back"
          value={String(stats.ready)}
          hint="finished, awaiting return"
        />
      </div>

      <div className="mb-4">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open batches</SelectItem>
            <SelectItem value="received">Received</SelectItem>
            <SelectItem value="washing">Washing</SelectItem>
            <SelectItem value="drying">Drying</SelectItem>
            <SelectItem value="finishing">Finishing</SelectItem>
            <SelectItem value="ready">Ready</SelectItem>
            <SelectItem value="all">All batches</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <SectionCard
        title="Batch register"
        description="Every linen handover recorded for this property."
      >
        <QueryState
          isLoading={batches.isLoading}
          error={batches.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No linen batches"
              description="Receive a linen handover from Housekeeping to start the conveyor."
              icon={WashingMachine}
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Received</TableHead>
                  <TableHead>Attendant</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const status = str(row["status"], "received");
                  const next = nextLaundryStatus(status);
                  return (
                    <TableRow key={String(row["id"])}>
                      <TableCell className="font-medium">{str(row["batch_number"])}</TableCell>
                      <TableCell>{titleCase(str(row["batch_kind"], "linen"))}</TableCell>
                      <TableCell>{shortDateTime(row["received_at"] as string)}</TableCell>
                      <TableCell>
                        {mayAssign ? (
                          <Select
                            value={row["attendant_id"] ? String(row["attendant_id"]) : ""}
                            onValueChange={(v) =>
                              assign.mutate({ batchId: String(row["id"]), attendantId: v })
                            }
                          >
                            <SelectTrigger className="w-48">
                              <SelectValue placeholder="Assign attendant" />
                            </SelectTrigger>
                            <SelectContent>
                              {(staff.data ?? []).map((s) => (
                                <SelectItem key={String(s["id"])} value={String(s["id"])}>
                                  {str(s["full_name"], "Attendant")}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          (staffName(row["attendant_id"]) ?? "Unassigned")
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusPill tone={laundryBatchTone(status)}>
                          {titleCase(status.replace("-", " "))}
                        </StatusPill>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {mayManage && next && status !== "ready" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={advance.isPending}
                              onClick={() =>
                                advance.mutate({ batchId: String(row["id"]), status: next })
                              }
                            >
                              {titleCase(next.replace("-", " "))}
                            </Button>
                          ) : null}
                          {mayManage && ["ready", "handed-over"].includes(status) ? (
                            <Button size="sm" onClick={() => setReturning(row)}>
                              Reconcile return
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>

      {/* Receive linen */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isGuestBatch ? "Receive guest garments into Laundry" : "Receive linen into Laundry"}
            </DialogTitle>
            <DialogDescription>
              {isGuestBatch
                ? "Guest garments are the guest's own property — count them by description, never against hotel linen stock."
                : "Count each item on handover — the count is what Housekeeping is owed back."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Batch kind</Label>
              <Select
                value={kind}
                onValueChange={(v) => {
                  setKind(v);
                  resetLines();
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LAUNDRY_BATCH_KINDS.map((k) => (
                    <SelectItem key={k.key} value={k.key}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isGuestBatch ? (
              <div>
                <Label>Guest laundry order</Label>
                <Select value={guestOrderId} onValueChange={pickGuestOrder}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        openGuestOrders.length ? "Select the guest order" : "No open guest orders"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {openGuestOrders.map((o) => (
                      <SelectItem key={String(o["id"])} value={String(o["id"])}>
                        {str(o["laundry_number"], "Order")} · Room{" "}
                        {str((o["rooms"] as LaundryRow | null)?.["room_number"], "—")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Selecting an order pulls its garment list. Returns post discrepancies back to that
                  order.
                </p>
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>{isGuestBatch ? "Garments" : "Items"}</Label>
              {lines.map((line, idx) => (
                <div key={idx} className="grid grid-cols-[1fr_90px_32px] gap-2">
                  {isGuestBatch ? (
                    <Input
                      value={line.description}
                      placeholder="Garment description (e.g. cotton shirt)"
                      onChange={(e) =>
                        setLines((ls) =>
                          ls.map((l, i) => (i === idx ? { ...l, description: e.target.value } : l)),
                        )
                      }
                    />
                  ) : (
                    <Select
                      value={line.linen_item_id}
                      onValueChange={(v) =>
                        setLines((ls) =>
                          ls.map((l, i) =>
                            i === idx
                              ? {
                                  ...l,
                                  linen_item_id: v,
                                  description: str(
                                    (linen.data ?? []).find((li) => String(li["id"]) === v)?.[
                                      "name"
                                    ],
                                    "",
                                  ),
                                }
                              : l,
                          ),
                        )
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Linen item" />
                      </SelectTrigger>
                      <SelectContent>
                        {(linen.data ?? []).map((li) => (
                          <SelectItem key={String(li["id"])} value={String(li["id"])}>
                            {str(li["name"], "Linen")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Input
                    type="number"
                    min={1}
                    value={line.quantity}
                    onChange={(e) =>
                      setLines((ls) =>
                        ls.map((l, i) =>
                          i === idx ? { ...l, quantity: Number(e.target.value) } : l,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-10 px-2"
                    disabled={lines.length === 1}
                    onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}
                  >
                    ✕
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setLines((ls) => [...ls, { linen_item_id: "", description: "", quantity: 1 }])
                }
              >
                Add line
              </Button>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional handover notes"
              />
            </div>
            {!isGuestBatch && linen.data && linen.data.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No linen items are configured yet. Configure the linen catalogue before receiving
                handovers.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              disabled={createBatch.isPending || !linesValid}
              onClick={() =>
                createBatch.mutate(
                  {
                    kind,
                    notes: notes.trim() || null,
                    guestOrderId: isGuestBatch ? guestOrderId || null : null,
                    items: lines
                      .filter(
                        (l) =>
                          (isGuestBatch ? l.description.trim() : l.linen_item_id) && l.quantity > 0,
                      )
                      .map((l) => ({
                        linen_item_id: isGuestBatch ? null : l.linen_item_id,
                        description: l.description.trim() || null,
                        quantity: l.quantity,
                      })),
                  },
                  {
                    onSuccess: () => {
                      setOpen(false);
                      setNotes("");
                      resetLines();
                    },
                  },
                )
              }
            >
              Receive batch
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReturnDialog batch={returning} onClose={() => setReturning(null)} />
    </div>
  );
}

function ReturnDialog({ batch, onClose }: { batch: LaundryRow | null; onClose: () => void }) {
  const items = useLaundryBatchItems(batch ? String(batch["id"]) : null);
  const back = useReturnLaundryBatch();
  const [counts, setCounts] = useState<Record<string, { returned: number; damaged: number }>>({});

  const rows = (items.data ?? []) as LaundryRow[];
  const valueFor = (id: string, issued: number) => counts[id] ?? { returned: issued, damaged: 0 };

  return (
    <Dialog
      open={Boolean(batch)}
      onOpenChange={(o) => {
        if (!o) {
          setCounts({});
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Reconcile {str(batch?.["batch_number"], "batch")}</DialogTitle>
          <DialogDescription>
            Anything not returned or returned damaged automatically raises a linen incident for
            review.
          </DialogDescription>
        </DialogHeader>
        <QueryState
          isLoading={items.isLoading}
          error={items.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              title="No lines on this batch"
              description="This batch has no counted items."
            />
          }
        >
          <div className="space-y-3">
            {rows.map((row) => {
              const id = String(row["id"]);
              const issued = num(row["quantity"]);
              const v = valueFor(id, issued);
              const missing = Math.max(issued - v.returned - v.damaged, 0);
              return (
                <div key={id} className="rounded-lg border border-border/70 p-3">
                  <p className="text-sm font-medium">
                    {str(
                      row["description"],
                      str((row["linen_items"] as LaundryRow | null)?.["name"], "Linen"),
                    )}
                  </p>
                  <p className="mb-2 text-xs text-muted-foreground">Handed over: {issued}</p>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs">Returned clean</Label>
                      <Input
                        type="number"
                        min={0}
                        max={issued}
                        value={v.returned}
                        onChange={(e) =>
                          setCounts((c) => ({
                            ...c,
                            [id]: { ...v, returned: Number(e.target.value) },
                          }))
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Damaged</Label>
                      <Input
                        type="number"
                        min={0}
                        max={issued}
                        value={v.damaged}
                        onChange={(e) =>
                          setCounts((c) => ({
                            ...c,
                            [id]: { ...v, damaged: Number(e.target.value) },
                          }))
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Missing</Label>
                      <Input readOnly value={missing} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </QueryState>
        <DialogFooter>
          <Button
            disabled={back.isPending || rows.length === 0}
            onClick={() =>
              back.mutate(
                {
                  batchId: String(batch?.["id"]),
                  lines: rows.map((row) => {
                    const id = String(row["id"]);
                    const v = valueFor(id, num(row["quantity"]));
                    return { id, returned_quantity: v.returned, damaged_quantity: v.damaged };
                  }),
                },
                {
                  onSuccess: () => {
                    setCounts({});
                    onClose();
                  },
                },
              )
            }
          >
            Confirm hand-back
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
