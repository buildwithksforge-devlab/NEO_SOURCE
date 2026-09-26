/**
 * Delivery zone configuration.
 * Zones decide the delivery fee, minimum order and service window used by
 * `delivery_quote_cart`; without at least one active zone the customer app
 * cannot place a delivery order. The database remains authoritative — this
 * card only maintains the configuration rows.
 */
import { useMemo, useState } from "react";
import { MapPinned } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import { money } from "@/lib/delivery";
import { useDeliveryZones, useSaveZone } from "@/lib/delivery-data";

type Row = Record<string, unknown>;

type Draft = {
  id?: string;
  name: string;
  description: string;
  areas: string;
  min_order: string;
  base_fee: string;
  distance_fee_per_km: string;
  free_delivery_threshold: string;
  eta_minutes: string;
  service_start: string;
  service_end: string;
  active: boolean;
};

function emptyDraft(): Draft {
  return {
    name: "",
    description: "",
    areas: "",
    min_order: "0",
    base_fee: "0",
    distance_fee_per_km: "0",
    free_delivery_threshold: "",
    eta_minutes: "45",
    service_start: "08:00",
    service_end: "22:00",
    active: true,
  };
}

function toDraft(row: Row): Draft {
  const areas = (row["areas"] as string[] | null) ?? [];
  return {
    id: String(row["id"]),
    name: String(row["name"] ?? ""),
    description: String(row["description"] ?? ""),
    areas: areas.join(", "),
    min_order: String(row["min_order"] ?? 0),
    base_fee: String(row["base_fee"] ?? 0),
    distance_fee_per_km: String(row["distance_fee_per_km"] ?? 0),
    free_delivery_threshold:
      row["free_delivery_threshold"] === null || row["free_delivery_threshold"] === undefined
        ? ""
        : String(row["free_delivery_threshold"]),
    eta_minutes: String(row["eta_minutes"] ?? 45),
    service_start: String(row["service_start"] ?? "08:00:00").slice(0, 5),
    service_end: String(row["service_end"] ?? "22:00:00").slice(0, 5),
    active: Boolean(row["active"]),
  };
}

export function DeliveryZonesCard({ branchId }: { branchId?: string | null }) {
  const { can } = useAuth();
  const zones = useDeliveryZones(branchId);
  const save = useSaveZone();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);

  const manage = can("delivery", "zones.manage");
  const rows = useMemo(() => (zones.data ?? []) as Row[], [zones.data]);

  function edit(row?: Row) {
    setDraft(row ? toDraft(row) : emptyDraft());
    setOpen(true);
  }

  function submit() {
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    save.mutate(
      {
        ...(draft.id ? { id: draft.id } : {}),
        branch_id: branchId ?? null,
        name: draft.name.trim(),
        description: draft.description.trim(),
        areas: draft.areas
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
        min_order: num(draft.min_order) ?? 0,
        base_fee: num(draft.base_fee) ?? 0,
        distance_fee_per_km: num(draft.distance_fee_per_km) ?? 0,
        free_delivery_threshold: num(draft.free_delivery_threshold),
        eta_minutes: num(draft.eta_minutes) ?? 45,
        service_start: `${draft.service_start}:00`,
        service_end: `${draft.service_end}:00`,
        active: draft.active,
      },
      { onSuccess: () => setOpen(false) },
    );
  }

  return (
    <SectionCard
      title="Delivery zones"
      description="Fees, minimum order and service hours per served area. The customer app can only order inside an active zone."
      actions={
        manage ? (
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" onClick={() => edit()}>
                New zone
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
              <DialogHeader>
                <DialogTitle>{draft.id ? "Edit delivery zone" : "New delivery zone"}</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Zone name" className="sm:col-span-2">
                  <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Westlands" />
                </Field>
                <Field label="Description" className="sm:col-span-2">
                  <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </Field>
                <Field label="Areas covered (comma separated)" className="sm:col-span-2">
                  <Input value={draft.areas} onChange={(e) => setDraft({ ...draft, areas: e.target.value })} placeholder="Parklands, Highridge" />
                </Field>
                <Field label="Base fee">
                  <Input inputMode="decimal" value={draft.base_fee} onChange={(e) => setDraft({ ...draft, base_fee: e.target.value })} />
                </Field>
                <Field label="Fee per km">
                  <Input inputMode="decimal" value={draft.distance_fee_per_km} onChange={(e) => setDraft({ ...draft, distance_fee_per_km: e.target.value })} />
                </Field>
                <Field label="Minimum order">
                  <Input inputMode="decimal" value={draft.min_order} onChange={(e) => setDraft({ ...draft, min_order: e.target.value })} />
                </Field>
                <Field label="Free delivery above (blank = never)">
                  <Input inputMode="decimal" value={draft.free_delivery_threshold} onChange={(e) => setDraft({ ...draft, free_delivery_threshold: e.target.value })} />
                </Field>
                <Field label="ETA (minutes)">
                  <Input inputMode="numeric" value={draft.eta_minutes} onChange={(e) => setDraft({ ...draft, eta_minutes: e.target.value })} />
                </Field>
                <Field label="Active">
                  <div className="flex h-10 items-center">
                    <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} />
                  </div>
                </Field>
                <Field label="Service start">
                  <Input type="time" value={draft.service_start} onChange={(e) => setDraft({ ...draft, service_start: e.target.value })} />
                </Field>
                <Field label="Service end">
                  <Input type="time" value={draft.service_end} onChange={(e) => setDraft({ ...draft, service_end: e.target.value })} />
                </Field>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button disabled={save.isPending || draft.name.trim().length === 0} onClick={submit}>
                  {save.isPending ? "Saving…" : "Save zone"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null
      }
    >
      <QueryState
        isLoading={zones.isLoading}
        error={zones.error}
        isEmpty={rows.length === 0}
        empty={
          <EmptyState
            title="No delivery zones configured"
            description="Add at least one active zone so the customer delivery app can quote fees and accept orders."
            icon={MapPinned}
          />
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Zone</TableHead>
                <TableHead>Fee</TableHead>
                <TableHead>Min order</TableHead>
                <TableHead>ETA</TableHead>
                <TableHead>Service hours</TableHead>
                <TableHead>Status</TableHead>
                {manage ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((z) => (
                <TableRow key={String(z["id"])}>
                  <TableCell className="font-medium">
                    {String(z["name"])}
                    <div className="text-xs font-normal text-muted-foreground">
                      {((z["areas"] as string[] | null) ?? []).join(", ") || String(z["description"] ?? "")}
                    </div>
                  </TableCell>
                  <TableCell>{money(z["base_fee"] as number)}</TableCell>
                  <TableCell>{money(z["min_order"] as number)}</TableCell>
                  <TableCell>{String(z["eta_minutes"] ?? "—")} min</TableCell>
                  <TableCell className="text-sm">
                    {String(z["service_start"] ?? "").slice(0, 5)} – {String(z["service_end"] ?? "").slice(0, 5)}
                  </TableCell>
                  <TableCell>
                    <StatusPill tone={z["active"] ? "success" : "default"}>{z["active"] ? "Active" : "Inactive"}</StatusPill>
                  </TableCell>
                  {manage ? (
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => edit(z)}>
                        Edit
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </QueryState>
    </SectionCard>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <Label className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
