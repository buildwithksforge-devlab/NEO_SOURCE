/**
 * Rider roster — the authoritative link between a staff account that holds a
 * rider capability and the delivery dispatch roster. Enrolment, reinstatement
 * and retirement are all server-validated; the browser never writes the roster
 * directly.
 */
import { useState } from "react";
import { Truck, UserPlus } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { EmptyState, QueryState } from "@/components/operations/OpsShared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import { riderStatusTone, titleCase } from "@/lib/delivery";
import {
  useEnrolRider,
  useRetireRider,
  useRiderCandidates,
  useRiderNotifications,
  useRiderRoster,
  useReconcileRiders,
} from "@/lib/delivery-data";

type Row = Record<string, unknown>;

const LINKAGE_COPY: Record<string, { label: string; tone: "success" | "warning" | "destructive" }> = {
  linked: { label: "Staff linked", tone: "success" },
  unlinked: { label: "No staff account", tone: "warning" },
  "missing-account": { label: "Account removed", tone: "destructive" },
  "account-inactive": { label: "Account inactive", tone: "destructive" },
  "capability-missing": { label: "Rider role removed", tone: "warning" },
};

const VEHICLES = ["motorcycle", "bicycle", "scooter", "car", "van", "on-foot"];

function tone(t: string) {
  return t === "neutral" || t === "danger" ? (t === "danger" ? "destructive" : "default") : (t as "success" | "warning" | "info" | "default");
}

export function RiderRosterCard({ branchId }: { branchId?: string | null | undefined }) {
  const { can } = useAuth();
  const manage = can("delivery", "riders.manage");
  const roster = useRiderRoster(branchId);
  const reconcile = useReconcileRiders();
  const [open, setOpen] = useState(false);
  const unlinked = (roster.data ?? []).filter((r: Row) => !r["profile_id"]).length;

  return (
    <SectionCard
      title="Rider roster"
      description="A rider is a staff identity: user account → staff profile → property → rider record → shift → availability → dispatch. Reconciling repairs any broken link."
      actions={
        manage ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={reconcile.isPending}
              onClick={() => reconcile.mutate(true)}
            >
              Reconcile identities{unlinked > 0 ? ` (${unlinked})` : ""}
            </Button>
            <EnrolRiderDialog branchId={branchId} open={open} onOpenChange={setOpen} />
          </div>
        ) : undefined
      }
    >

      <QueryState
        isLoading={roster.isLoading}
        error={roster.error}
        isEmpty={(roster.data ?? []).length === 0}
        empty={
          <EmptyState
            title="No riders on the roster"
            description={
              manage
                ? "Assign the Rider role to a staff member, then add them to the roster."
                : "Riders appear here once a dispatcher links a staff rider to the roster."
            }
            icon={Truck}
          />
        }
      >
        <div className="space-y-2">
          {(roster.data ?? []).map((r: Row) => {
            const linkage = LINKAGE_COPY[String(r["linkage_status"] ?? "unlinked")] ?? LINKAGE_COPY["unlinked"]!;
            return (
              <div
                key={String(r["id"])}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {String(r["display_name"] ?? "Rider")}{" "}
                    <span className="text-xs font-normal text-muted-foreground">{String(r["rider_code"] ?? "")}</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {String(r["staff_id"] ?? "No staff ID")} · {titleCase(String(r["vehicle_type"] ?? "—"))} ·{" "}
                    {String(r["active_orders"] ?? 0)} active
                  </p>
                  {/* Operating record sits on the roster row itself, not only on a separate card. */}
                  <p className="truncate text-xs text-muted-foreground">
                    {String(r["delivered_orders"] ?? 0)} completed · {String(r["cancelled_orders"] ?? 0)} cancelled ·{" "}
                    {r["on_time_rate"] === null || r["on_time_rate"] === undefined
                      ? "on-time not measurable"
                      : `${String(r["on_time_rate"])}% on time`}{" "}
                    ·{" "}
                    {r["avg_assignment_minutes"] === null || r["avg_assignment_minutes"] === undefined
                      ? "—"
                      : `${String(r["avg_assignment_minutes"])}m assign→deliver`}{" "}
                    ·{" "}
                    {r["avg_pickup_minutes"] === null || r["avg_pickup_minutes"] === undefined
                      ? "—"
                      : `${String(r["avg_pickup_minutes"])}m pickup→deliver`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusPill tone={linkage.tone}>{linkage.label}</StatusPill>
                  <StatusPill tone={tone(riderStatusTone(String(r["availability_status"])))}>
                    {titleCase(String(r["availability_status"]))}
                  </StatusPill>
                  <RiderNotificationTrail riderId={String(r["id"])} name={String(r["display_name"] ?? "Rider")} />
                  {manage && Boolean(r["active"]) ? <RetireButton riderId={String(r["id"])} /> : null}
                </div>
              </div>
            );
          })}
        </div>
      </QueryState>
    </SectionCard>
  );
}

/**
 * Notification trail for one rider. The source key is shown verbatim so a
 * dispatcher can confirm that a retried assignment reused the same key rather
 * than notifying the rider twice.
 */
function RiderNotificationTrail({ riderId, name }: { riderId: string; name: string }) {
  const [open, setOpen] = useState(false);
  const trail = useRiderNotifications(open ? riderId : null);
  const rows = trail.data ?? [];
  const keys = rows.map((r) => r.idempotency_key).filter(Boolean);
  const duplicates = keys.length - new Set(keys).size;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          Notifications
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Notification trail — {name}</DialogTitle>
          <DialogDescription>
            Assignment, reassignment, availability, shift and roster notifications, with the source key that suppresses
            duplicates.
          </DialogDescription>
        </DialogHeader>
        <QueryState
          isLoading={trail.isLoading}
          error={trail.error}
          isEmpty={rows.length === 0}
          empty={<EmptyState title="No notifications yet" description="This rider has not been notified of anything." />}
        >
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {rows.length} notifications · {duplicates === 0 ? "no duplicate source keys" : `${duplicates} duplicate keys`}
            </p>
            {rows.map((n) => (
              <div key={`${n.idempotency_key ?? n.created_at}-${n.created_at}`} className="rounded-lg border border-border/70 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{n.title ?? n.event_type}</p>
                  <div className="flex items-center gap-2">
                    <StatusPill tone="default">{n.event_type}</StatusPill>
                    <StatusPill tone={n.read_at ? "success" : "warning"}>{n.read_at ? "read" : (n.delivery_status ?? "sent")}</StatusPill>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{n.body ?? ""}</p>
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                  {n.order_number ? `${n.order_number} · ` : ""}
                  {n.idempotency_key ?? "no source key"}
                </p>
              </div>
            ))}
          </div>
        </QueryState>
      </DialogContent>
    </Dialog>
  );
}

function RetireButton({ riderId }: { riderId: string }) {
  const retire = useRetireRider();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={retire.isPending}
      onClick={() => retire.mutate({ riderId, reason: "Retired from the delivery roster" })}
    >
      Retire
    </Button>
  );
}

function EnrolRiderDialog({
  branchId,
  open,
  onOpenChange,
}: {
  branchId?: string | null | undefined;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const candidates = useRiderCandidates(branchId, open);
  const enrol = useEnrolRider();
  const [profileId, setProfileId] = useState("");
  const [vehicleType, setVehicleType] = useState("motorcycle");
  const [registration, setRegistration] = useState("");
  const [phone, setPhone] = useState("");
  const [maxActive, setMaxActive] = useState("3");

  const list = (candidates.data ?? []).filter((c: Row) => !c["rider_profile_id"] || c["rider_active"] === false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <UserPlus className="mr-2 h-4 w-4" /> Add staff rider
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a staff rider to the roster</DialogTitle>
          <DialogDescription>
            Only active staff accounts that hold a rider capability can be rostered. The rider code is generated by the
            system.
          </DialogDescription>
        </DialogHeader>

        <QueryState
          isLoading={candidates.isLoading}
          error={candidates.error}
          isEmpty={list.length === 0}
          empty={
            <EmptyState
              title="No eligible staff"
              description="Assign the Rider role to a staff member in Administration → Staff before rostering them."
              icon={Truck}
            />
          }
        >
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Staff member</Label>
              <Select value={profileId} onValueChange={setProfileId}>
                <SelectTrigger><SelectValue placeholder="Select a staff rider" /></SelectTrigger>
                <SelectContent>
                  {list.map((c: Row) => (
                    <SelectItem key={String(c["profile_id"])} value={String(c["profile_id"])}>
                      {String(c["full_name"] ?? "Staff")} · {String(c["staff_id"] ?? "—")}
                      {c["rider_profile_id"] ? " (reinstate)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Vehicle</Label>
                <Select value={vehicleType} onValueChange={setVehicleType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {VEHICLES.map((v) => (
                      <SelectItem key={v} value={v}>{titleCase(v)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Registration</Label>
                <Input value={registration} onChange={(e) => setRegistration(e.target.value)} placeholder="Optional" />
              </div>
              <div className="space-y-1">
                <Label>Work phone</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" />
              </div>
              <div className="space-y-1">
                <Label>Max active deliveries</Label>
                <Input
                  type="number"
                  min={1}
                  value={maxActive}
                  onChange={(e) => setMaxActive(e.target.value)}
                />
              </div>
            </div>
          </div>
        </QueryState>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={!profileId || enrol.isPending}
            onClick={() =>
              enrol.mutate(
                {
                  profileId,
                  branchId,
                  vehicleType,
                  vehicleRegistration: registration.trim() || null,
                  workPhone: phone.trim() || null,
                  maxActive: Number(maxActive) || 3,
                },
                {
                  onSuccess: () => {
                    setProfileId("");
                    setRegistration("");
                    setPhone("");
                    onOpenChange(false);
                  },
                },
              )
            }
          >
            Add to roster
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
