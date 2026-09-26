import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { LayoutGrid, CalendarClock } from "lucide-react";
import { PageHeader, SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, PosGuard, QueryState } from "@/components/pos/PosShared";
import { FloorTableCard, elapsedLabel, productionLabel } from "@/components/pos/FloorTableCard";
import type { FloorTableState } from "@/components/pos/FloorTableCard";
import { buildFloorState, summariseFloor } from "@/lib/pos-floor";
import { MoneyValue } from "@/components/common/MoneyValue";
import { useAuth } from "@/lib/auth";
import { resolvePosApprovalGates } from "@/lib/pos-approvals-authority";
import { RESERVATION_STATUSES, TABLE_STATUSES, titleCase } from "@/lib/pos";
import {
  useCreateOrder,
  useRestaurantAreas,
  useRestaurantTables,
  usePosOrders,
  useSaveRecord,
  useTableReservations,
} from "@/lib/pos-data";

export const Route = createFileRoute("/_shell/pos/floor")({
  head: () => ({
    meta: [
      { title: "Restaurant Floor — NEØ" },
      {
        name: "description",
        content:
          "Visual table layout, seating, waiter assignment and restaurant table reservations.",
      },
      { property: "og:title", content: "Restaurant Floor — NEØ" },
      {
        property: "og:description",
        content:
          "Visual table layout, seating, waiter assignment and restaurant table reservations.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PosGuard action="tables.view" path="/pos/floor">
      <FloorPage />
    </PosGuard>
  ),
});

function FloorPage() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const approvals = resolvePosApprovalGates(can);
  const areas = useRestaurantAreas();
  const tables = useRestaurantTables();
  const reservations = useTableReservations(new Date(Date.now() - 3600_000).toISOString());
  const openOrders = usePosOrders("open");
  const saveArea = useSaveRecord("restaurant_areas");
  const saveTable = useSaveRecord("restaurant_tables");
  const saveReservation = useSaveRecord("table_reservations");
  const createOrder = useCreateOrder();

  const [areaFilter, setAreaFilter] = useState("all");
  const [tableDialog, setTableDialog] = useState(false);
  const [areaDialog, setAreaDialog] = useState(false);
  const [resDialog, setResDialog] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const floor = useMemo(
    () =>
      buildFloorState(
        (tables.data ?? []).filter((t) => areaFilter === "all" || t.area_id === areaFilter),
        openOrders.data ?? [],
      ),
    [tables.data, openOrders.data, areaFilter],
  );
  const summary = summariseFloor(floor);
  const active = floor.find((t) => t.id === activeId) ?? null;

  async function seatAndOpen(tableId: string, guests: number) {
    const order = await createOrder.mutateAsync({
      order_type: "dine-in",
      table_id: tableId,
      guest_count: guests,
    });
    await saveTable.mutateAsync({ id: tableId, values: { status: "ordering" } });
    setActiveId(null);
    void navigate({ to: "/pos/orders/$id", params: { id: order.id } });
  }

  return (
    <div>
      <PageHeader
        eyebrow="Restaurant & POS"
        title="Restaurant Floor"
        description="Touch-friendly table layout with live service state. Seating a guest opens one authoritative order for that table."
        actions={
          can("pos", "floor.edit") ? (
            <>
              <Button variant="outline" onClick={() => setAreaDialog(true)}>
                New area
              </Button>
              <Button onClick={() => setTableDialog(true)}>New table</Button>
            </>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={areaFilter} onValueChange={setAreaFilter}>
          <SelectTrigger className="w-56" aria-label="Filter by area">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All areas</SelectItem>
            {(areas.data ?? []).map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => setResDialog(true)}>
          <CalendarClock className="mr-2 size-4" /> New table reservation
        </Button>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <FloorMetric label="Tables" value={String(summary.total)} />
        <FloorMetric label="Occupied" value={`${summary.occupied} / ${summary.total}`} />
        <FloorMetric label="Covers seated" value={String(summary.covers)} />
        <FloorMetric label="Needs attention" value={String(summary.attention)} />
        <FloorMetric
          label="Unpaid on floor"
          value={<MoneyValue value={summary.outstanding} />}
        />
      </div>

      <SectionCard
        title="Table layout"
        description="Tap a table to seat guests, open its order or change its state."
      >
        <QueryState
          isLoading={tables.isLoading || openOrders.isLoading}
          error={tables.error ?? openOrders.error}
          isEmpty={floor.length === 0}
          empty={
            <EmptyState
              icon={LayoutGrid}
              title="No tables configured"
              description="Create restaurant areas and tables to build your floor plan. Nothing is pre-filled — this is your real property layout."
            />
          }
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {floor.map((t) => (
              <FloorTableCard key={t.id} table={t} onSelect={(sel) => setActiveId(sel.id)} />
            ))}
          </div>
        </QueryState>
      </SectionCard>

      <SectionCard
        className="mt-6"
        title="Table reservations"
        description="Restaurant bookings only — room reservations stay in Front Office."
      >
        <QueryState
          isLoading={reservations.isLoading}
          error={reservations.error}
          isEmpty={(reservations.data ?? []).length === 0}
          empty={
            <EmptyState
              title="No upcoming table reservations"
              description="Reservations created here block their table for the booked period."
            />
          }
        >
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Guest</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>To</TableHead>
                  <TableHead>Party</TableHead>
                  <TableHead>Table</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(reservations.data ?? []).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.customers?.full_name ?? r.contact_name ?? "—"}</TableCell>
                    <TableCell>{new Date(r.reserved_from).toLocaleString()}</TableCell>
                    <TableCell>{new Date(r.reserved_to).toLocaleTimeString()}</TableCell>
                    <TableCell>{r.guest_count}</TableCell>
                    <TableCell>{r.restaurant_tables?.code ?? "Unassigned"}</TableCell>
                    <TableCell>{titleCase(r.status)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        </QueryState>
      </SectionCard>

      {/* Table service context */}
      <Dialog open={Boolean(active)} onOpenChange={(o) => !o && setActiveId(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Table {active?.code}</DialogTitle>
            <DialogDescription>
              {active?.areaName} · {active?.capacity} seats · {titleCase(active?.status ?? "")}
            </DialogDescription>
          </DialogHeader>

          {active?.order ? (
            <div className="space-y-3">
              <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <ServiceFact label="Open bill" value={active.order.orderNumber} />
                <ServiceFact label="Guests" value={String(active.order.guestCount)} />
                <ServiceFact
                  label="Attendant"
                  value={active.order.waiterName ?? "Unassigned"}
                />
                <ServiceFact
                  label="Elapsed"
                  value={elapsedLabel(active.order.elapsedMinutes)}
                />
                <ServiceFact label="Service state" value={productionLabel(active.order.status)} />
                <ServiceFact
                  label="Outstanding"
                  value={
                    <MoneyValue
                      value={active.order.outstanding}
                      currency={active.order.currency}
                    />
                  }
                />
              </dl>
              {active.order.needsAttention ? (
                <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                  This table has been waiting longer than the service threshold. Check the
                  order before it escalates.
                </p>
              ) : null}
              <Button
                className="w-full"
                onClick={() => {
                  const id = active.order!.id;
                  setActiveId(null);
                  void navigate({ to: "/pos/orders/$id", params: { id } });
                }}
              >
                Open bill
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                No open bill on this table. Seating guests opens one authoritative order.
              </p>
              <Button
                className="w-full"
                disabled={!can("pos", "orders.create")}
                onClick={() => active && void seatAndOpen(active.id, 2)}
              >
                Seat guests &amp; open order
              </Button>
            </div>
          )}

          {/*
            Sensitive money movements never happen from the floor. Voids, comps
            and refunds are decided on the Approvals surface by whoever holds
            `pos.approvals.decide`; everyone else is told where the decision is
            taken rather than being shown a control they cannot use.
          */}
          {active?.order ? (
            <div className="grid gap-2 border-t border-border pt-3">
              <Label>Void, comp or refund</Label>
              {approvals.canDecide ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    setActiveId(null);
                    void navigate({ to: "/pos/approvals" });
                  }}
                >
                  Open approvals
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">
                  A manager with approval authority must decide this from POS Approvals.
                </p>
              )}
            </div>
          ) : null}

          <div className="grid gap-2 border-t border-border pt-3">
            <Label>Set table status</Label>
            {can("pos", "floor.edit") ? (
              <Select
                value={active?.status ?? ""}
                onValueChange={(v) =>
                  active && saveTable.mutate({ id: active.id, values: { status: v } })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TABLE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {titleCase(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground">
                {titleCase(active?.status ?? "unknown")} — you may view the floor but not change table
                state.
              </p>
            )}
          </div>

        </DialogContent>
      </Dialog>

      <RecordDialog
        open={areaDialog}
        onOpenChange={setAreaDialog}
        title="New restaurant area"
        fields={[
          { name: "name", label: "Area name", required: true },
          { name: "description", label: "Description" },
        ]}
        onSubmit={(values) => saveArea.mutate({ values })}
      />

      <RecordDialog
        open={tableDialog}
        onOpenChange={setTableDialog}
        title="New table"
        fields={[
          { name: "code", label: "Table number / name", required: true },
          { name: "capacity", label: "Capacity", type: "number" },
        ]}
        selects={[
          {
            name: "area_id",
            label: "Area",
            options: (areas.data ?? []).map((a) => ({ value: a.id, label: a.name })),
          },
        ]}
        onSubmit={(values) =>
          saveTable.mutate({
            values: { ...values, capacity: Number(values["capacity"] ?? 2) || 2 },
          })
        }
      />

      <RecordDialog
        open={resDialog}
        onOpenChange={setResDialog}
        title="New table reservation"
        fields={[
          { name: "contact_name", label: "Guest name", required: true },
          { name: "contact_phone", label: "Contact phone" },
          { name: "reserved_from", label: "From", type: "datetime-local", required: true },
          { name: "reserved_to", label: "To", type: "datetime-local", required: true },
          { name: "guest_count", label: "Guests", type: "number" },
          { name: "special_requests", label: "Special requests" },
          { name: "dietary_requirements", label: "Dietary requirements" },
        ]}
        selects={[
          {
            name: "table_id",
            label: "Table",
            options: (tables.data ?? []).map((t) => ({ value: t.id, label: t.code })),
          },
          {
            name: "status",
            label: "Status",
            options: RESERVATION_STATUSES.map((s) => ({ value: s, label: titleCase(s) })),
          },
        ]}
        onSubmit={(values) =>
          saveReservation.mutate({
            values: {
              ...values,
              guest_count: Number(values["guest_count"] ?? 2) || 2,
              reserved_from: new Date(String(values["reserved_from"])).toISOString(),
              reserved_to: new Date(String(values["reserved_to"])).toISOString(),
              status: values["status"] ?? "confirmed",
            },
          })
        }
      />
    </div>
  );
}

function FloorMetric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-3">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold">{value}</div>
    </div>
  );
}

function ServiceFact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

type FieldDef = { name: string; label: string; type?: string; required?: boolean };
type SelectDef = { name: string; label: string; options: { value: string; label: string }[] };

export function RecordDialog({
  open,
  onOpenChange,
  title,
  fields,
  selects = [],
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  fields: FieldDef[];
  selects?: SelectDef[];
  onSubmit: (values: Record<string, string>) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setValues({});
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          {fields.map((f) => (
            <div key={f.name} className="grid gap-1.5">
              <Label htmlFor={f.name}>{f.label}</Label>
              <Input
                id={f.name}
                type={f.type ?? "text"}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              />
            </div>
          ))}
          {selects.map((s) => (
            <div key={s.name} className="grid gap-1.5">
              <Label>{s.label}</Label>
              <Select
                value={values[s.name] ?? ""}
                onValueChange={(v) => setValues((old) => ({ ...old, [s.name]: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {s.options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            onClick={() => {
              const missing = fields.filter((f) => f.required && !values[f.name]?.trim());
              if (missing.length) return;
              onSubmit(values);
              setValues({});
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
