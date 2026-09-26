import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Shirt } from "lucide-react";
import { PageHeader, SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import { EmptyState, OpsBadge, OpsGuard, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import {
  GUEST_LAUNDRY_STATUSES,
  LAUNDRY_SERVICE_TYPES,
  laundryTone,
  shortDateTime,
  titleCase,
  type Row,
} from "@/lib/operations";
import {
  useAdvanceLaundryOrder,
  useCreateLaundryOrder,
  useGuestLaundryOrders,
  useHousekeepingJobs,
  useLaundryPrices,
  usePostLaundryCharge,
  useRoomBoard,
} from "@/lib/operations-data";

export const Route = createFileRoute("/_shell/laundry/")({
  head: () => ({
    meta: [
      { title: "Laundry — NEØ Hospitality OS" },
      {
        name: "description",
        content: "Guest laundry orders, folio posting and the accommodation cleaning conveyor.",
      },
      { property: "og:title", content: "Laundry — NEØ Hospitality OS" },
      {
        property: "og:description",
        content: "Guest laundry orders, folio posting and the accommodation cleaning conveyor.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function manualLaundryTransitions(status: string): string[] {
  switch (status) {
    case "requested":
    case "awaiting-collection":
      return ["collected", "on-hold", "cancelled"];
    case "collected":
      return ["on-hold", "disputed", "cancelled"];
    case "ready-for-delivery":
      return ["delivered", "on-hold", "disputed"];
    case "delivered":
      return ["completed", "disputed"];
    case "on-hold":
      return ["collected", "disputed", "cancelled"];
    case "disputed":
      return ["on-hold", "ready-for-delivery", "cancelled"];
    default:
      return [];
  }
}

function Page() {
  const { can } = useAuth();
  const { branchId } = useActivePropertyFilter();

  const orders = useGuestLaundryOrders();
  const prices = useLaundryPrices();
  const rooms = useRoomBoard();
  const createOrder = useCreateLaundryOrder();
  const advanceOrder = useAdvanceLaundryOrder();
  const postCharge = usePostLaundryCharge();

  const [status, setStatus] = useState("open");
  const [open, setOpen] = useState(false);
  const [newRoom, setNewRoom] = useState("");
  const [newService, setNewService] = useState("wash-iron");
  const [newExpress, setNewExpress] = useState(false);
  const [lines, setLines] = useState<
    { description: string; quantity: number; unit_price: number; tax_rate: number }[]
  >([{ description: "", quantity: 1, unit_price: 0, tax_rate: 0 }]);

  const scoped = useMemo(() => {
    return (orders.data ?? []).filter((o) => !branchId || String(o["branch_id"]) === branchId);
  }, [orders.data, branchId]);

  const list = useMemo(() => {
    return scoped.filter((o) => {
      if (status === "open")
        return !["completed", "delivered", "cancelled"].includes(String(o["status"]));
      if (status !== "all") return String(o["status"]) === status;
      return true;
    });
  }, [scoped, status]);

  const ready = scoped.filter((o) => o["status"] === "ready-for-delivery").length;
  const inProgress = scoped.filter(
    (o) => !["completed", "delivered", "cancelled"].includes(String(o["status"])),
  ).length;
  const unposted = scoped.filter(
    (o) => o["posting_status"] !== "posted" && o["status"] !== "cancelled",
  ).length;

  const priceFor = (service: string) =>
    prices.data?.find((p) => p["service_type"] === service) ?? null;

  return (
    <OpsGuard module="laundry" action="guest.view">
      <PageHeader
        eyebrow="Operations"
        title="Laundry"
        description="Guest laundry intake, processing status and idempotent folio charging."
        actions={
          can("laundry", "edit") ? (
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button>New laundry order</Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Guest laundry order</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  <div>
                    <Label>Room</Label>
                    <Select value={newRoom} onValueChange={setNewRoom}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a room" />
                      </SelectTrigger>
                      <SelectContent>
                        {(rooms.data ?? []).map((r) => (
                          <SelectItem key={String(r["id"])} value={String(r["id"])}>
                            Room {String(r["room_number"])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Service type</Label>
                      <Select value={newService} onValueChange={setNewService}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {LAUNDRY_SERVICE_TYPES.map((s) => (
                            <SelectItem key={s.key} value={s.key}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Express</Label>
                      <div className="flex h-10 items-center gap-2">
                        <Checkbox
                          checked={newExpress}
                          onCheckedChange={(v) => setNewExpress(Boolean(v))}
                        />
                        <span className="text-sm text-muted-foreground">Priority turnaround</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <Label>Items</Label>
                    <div className="space-y-2">
                      {lines.map((line, idx) => (
                        <div key={idx} className="grid grid-cols-[1fr_80px_100px_32px] gap-2">
                          <Input
                            value={line.description}
                            placeholder="Description (e.g. Shirt)"
                            onChange={(e) =>
                              setLines((ls) =>
                                ls.map((l, i) =>
                                  i === idx ? { ...l, description: e.target.value } : l,
                                ),
                              )
                            }
                          />
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
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={line.unit_price}
                            onChange={(e) =>
                              setLines((ls) =>
                                ls.map((l, i) =>
                                  i === idx ? { ...l, unit_price: Number(e.target.value) } : l,
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
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => {
                        const service = priceFor(newService);
                        setLines((ls) => [
                          ...ls,
                          {
                            description: "",
                            quantity: 1,
                            unit_price: Number(service?.["unit_price"] ?? 0),
                            tax_rate: Number(service?.["tax_rate"] ?? 0),
                          },
                        ]);
                      }}
                    >
                      Add line
                    </Button>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    disabled={!newRoom || createOrder.isPending}
                    onClick={() =>
                      createOrder.mutate(
                        {
                          order: {
                            room_id: newRoom,
                            service_type: newService,
                            express: newExpress,
                          },
                          items: lines
                            .filter((l) => l.description.trim() && l.quantity > 0)
                            .map((l) => ({
                              description: l.description,
                              quantity: l.quantity,
                              unit_price: l.unit_price,
                              tax_rate: l.tax_rate,
                              service_type: newService,
                            })),
                        },
                        {
                          onSuccess: () => {
                            setOpen(false);
                            setLines([
                              { description: "", quantity: 1, unit_price: 0, tax_rate: 0 },
                            ]);
                            setNewRoom("");
                          },
                        },
                      )
                    }
                  >
                    Create order
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          ) : null
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          lead
          label="Orders in process"
          value={String(inProgress)}
          hint="excluding completed & cancelled"
        />
        <StatCard label="Ready for delivery" value={String(ready)} hint="awaiting guest handover" />
        <StatCard label="Unposted charges" value={String(unposted)} hint="awaiting folio posting" />
      </div>

      <div className="mb-4">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open orders</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
            {GUEST_LAUNDRY_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {titleCase(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <SectionCard
        title="Guest laundry orders"
        description="Status transitions are recorded against the real order records."
      >
        <QueryState
          isLoading={orders.isLoading}
          error={orders.error}
          isEmpty={list.length === 0}
          empty={
            <EmptyState
              title="No laundry orders"
              description="New guest orders appear here as they are raised. Charges post to the guest folio only when you confirm delivery."
              icon={Shirt}
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order</TableHead>
                  <TableHead>Room</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Posting</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.map((o) => (
                  <TableRow key={String(o["id"])}>
                    <TableCell className="font-medium">
                      {String(o["laundry_number"] ?? "—")}
                      <div className="text-xs font-normal text-muted-foreground">
                        {shortDateTime(o["requested_at"])}
                      </div>
                    </TableCell>
                    <TableCell>Room {String(o["rooms"]?.room_number ?? "—")}</TableCell>
                    <TableCell>
                      {titleCase(o["service_type"])}
                      {o["express"] ? (
                        <span className="ml-2 text-xs font-medium text-warning">express</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <OpsBadge value={o["status"]} tone={laundryTone(o["status"])} />
                    </TableCell>
                    <TableCell>
                      {Number(o["total"] ?? 0).toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                      })}
                    </TableCell>
                    <TableCell>
                      <OpsBadge
                        value={o["posting_status"] ?? "unposted"}
                        tone={
                          o["posting_status"] === "posted"
                            ? "success"
                            : o["posting_status"] === "blocked"
                              ? "destructive"
                              : "warning"
                        }
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {manualLaundryTransitions(String(o["status"])).length ? (
                          <Select
                            value={String(o["status"])}
                            onValueChange={(v) =>
                              v !== String(o["status"]) &&
                              advanceOrder.mutate({ id: String(o["id"]), status: v })
                            }
                          >
                            <SelectTrigger className="h-9 w-44">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={String(o["status"])} disabled>
                                {titleCase(String(o["status"]))}
                              </SelectItem>
                              {manualLaundryTransitions(String(o["status"])).map((s) => (
                                <SelectItem key={s} value={s}>
                                  {titleCase(s)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : !["delivered", "completed", "cancelled"].includes(String(o["status"])) ? (
                          <Button size="sm" variant="outline" asChild>
                            <Link to="/laundry/batches">Continue in batches</Link>
                          </Button>
                        ) : null}
                        {["delivered", "completed", "closed"].includes(String(o["status"])) &&
                        o["posting_status"] !== "posted" ? (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => postCharge.mutate(String(o["id"]))}
                            disabled={postCharge.isPending}
                          >
                            {o["posting_status"] === "blocked"
                              ? "Retry folio posting"
                              : "Post to folio"}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      <div className="mt-6">
        <AccommodationConveyor />
      </div>
    </OpsGuard>
  );
}

/**
 * Live accommodation conveyor: occupied → checkout → dirty → cleaning →
 * awaiting inspection → inspected/sellable. Derived entirely from the rooms
 * board and housekeeping job records — nothing here is simulated.
 */
function AccommodationConveyor() {
  const roomsQ = useRoomBoard();
  const jobsQ = useHousekeepingJobs();

  const rooms = roomsQ.data ?? [];
  const jobs = jobsQ.data ?? [];

  const byCondition = (c: string) =>
    rooms.filter((r) => String(r["room_condition"]).includes(c)).length;

  const stages = [
    {
      label: "Checkout",
      count: rooms.filter(
        (r) => r["occupancy_status"] === "occupied" && r["housekeeping_status"] === "dirty",
      ).length,
      hint: "vacating",
    },
    { label: "Dirty", count: byCondition("dirty"), hint: "awaiting clean" },
    {
      label: "Cleaning",
      count: jobs.filter((j) =>
        ["pending", "assigned", "in-progress", "rework"].includes(String(j["status"])),
      ).length,
      hint: "jobs active",
    },
    {
      label: "Awaiting inspection",
      count: jobs.filter((j) => j["status"] === "awaiting-inspection").length,
      hint: "jobs submitted",
    },
    {
      label: "Sellable",
      count: rooms.filter((r) => r["sellable"] === true).length,
      hint: "released rooms",
    },
  ];

  return (
    <SectionCard
      title="Accommodation conveyor"
      description="Checkout → housekeeping → cleaning → inspection → sellable. Live from the room board and cleaning jobs."
    >
      <QueryState
        isLoading={roomsQ.isLoading || jobsQ.isLoading}
        error={roomsQ.error ?? jobsQ.error}
        isEmpty={rooms.length === 0 && jobs.length === 0}
        empty={
          <EmptyState
            title="No room movement data"
            description="Room states will appear once rooms and cleaning jobs exist in this property."
            icon={Shirt}
          />
        }
      >
        <div className="grid gap-3 md:grid-cols-5">
          {stages.map((s, i) => (
            <div key={s.label} className="rounded-xl border border-border/70 p-4">
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-xs font-bold text-primary">
                  {i + 1}
                </span>
                <p className="text-sm font-semibold">{s.label}</p>
              </div>
              <p className="mt-2 text-2xl font-bold">{s.count}</p>
              <p className="text-xs text-muted-foreground">{s.hint}</p>
            </div>
          ))}
        </div>
      </QueryState>
    </SectionCard>
  );
}
