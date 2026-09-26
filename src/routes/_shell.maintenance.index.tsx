import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Wrench } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
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
import { useRooms } from "@/lib/pms-data";
import {
  PM_FREQUENCIES,
  WO_PRIORITIES,
  WO_STATUSES,
  woStatusTone,
  shortDateTime,
  titleCase,
  type Row,
} from "@/lib/operations";
import {
  maintStr,
  useMaintenanceCategories,
  useMaintenanceEscalationScan,
} from "@/lib/maintenance-department";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { Link } from "@tanstack/react-router";
import {
  useAssets,
  useGeneratePreventive,
  usePmPlans,
  useRoomState,
  useSavePmPlan,
  useSaveWorkOrder,
  useSetRoomBlock,
  useWorkOrders,
} from "@/lib/operations-data";
import { useMaintenanceTechnicians } from "@/lib/maintenance-department";
import {
  STAGE_LABELS,
  roomStage,
  type CanonicalRoomState,
  type RoomStage,
} from "@/lib/room-lifecycle";
import { useStableList } from "@/lib/stable-list";

export const Route = createFileRoute("/_shell/maintenance/")({
  head: () => ({
    meta: [
      { title: "Maintenance — NEØ Hospitality OS" },
      {
        name: "description",
        content: "Work orders, room blocking, preventive plans and the asset register.",
      },
      { property: "og:title", content: "Maintenance — NEØ Hospitality OS" },
      {
        property: "og:description",
        content: "Work orders, room blocking, preventive plans and the asset register.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Page,
});

function Page() {
  const { can } = useAuth();
  const { branchId } = useActivePropertyFilter();

  const orders = useWorkOrders();
  const rooms = useRooms();
  const roomStates = useRoomState();
  // One eligibility rule, decided in the database: only people who can actually
  // work a maintenance job at this property are offered anywhere on this page.
  const technicians = useMaintenanceTechnicians();
  const eligibleIds = useMemo(
    () => new Set((technicians.data ?? []).map((t) => String(t.id))),
    [technicians.data],
  );
  const assets = useAssets();
  const pmPlans = usePmPlans();
  const saveWO = useSaveWorkOrder();
  const setBlock = useSetRoomBlock();
  const savePm = useSavePmPlan();
  const generatePm = useGeneratePreventive();

  const categories = useMaintenanceCategories();
  const escalate = useMaintenanceEscalationScan();

  const [tab, setTab] = useState<"orders" | "pm" | "assets">("orders");
  const [open, setOpen] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [newPriority, setNewPriority] = useState("normal");
  const [newDesc, setNewDesc] = useState("");
  const [newBlocks, setNewBlocks] = useState(false);
  const [newRoom, setNewRoom] = useState("");
  const [newAsset, setNewAsset] = useState("");
  const [newLocation, setNewLocation] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newEstimate, setNewEstimate] = useState("");

  const [pmOpen, setPmOpen] = useState(false);
  const [pmName, setPmName] = useState("");
  const [pmType, setPmType] = useState("preventive");
  const [pmFreq, setPmFreq] = useState("monthly");
  const [pmAsset, setPmAsset] = useState("");
  const [pmNextDue, setPmNextDue] = useState("");
  const [pmAssignee, setPmAssignee] = useState("");

  const categoryOptions = useMemo(
    () =>
      (categories.data ?? [])
        .filter((c) => c["active"] !== false)
        .map((c) => ({
          id: String(c["id"]),
          name: maintStr(c["name"], "Unnamed category"),
          defaultPriority: c["default_priority"] ? String(c["default_priority"]) : null,
          code: c["code"] ? String(c["code"]) : null,
        })),
    [categories.data],
  );
  const categoryNameById = useMemo(
    () => new Map(categoryOptions.map((c) => [c.id, c.name])),
    [categoryOptions],
  );

  const scoped = useMemo(() => {
    const ordersScoped = (orders.data ?? []).filter(
      (o) => !branchId || String(o["branch_id"]) === branchId,
    );
    const pmScoped = (pmPlans.data ?? []).filter(
      (p) => !branchId || String(p["branch_id"]) === branchId,
    );
    const assetsScoped = (assets.data ?? []).filter(
      (a) => !branchId || String(a["branch_id"]) === branchId,
    );
    return { ordersScoped, pmScoped, assetsScoped };
  }, [orders.data, pmPlans.data, assets.data, branchId]);

  const openOrders = scoped.ordersScoped.filter(
    (o) => !["closed", "cancelled"].includes(String(o["status"])),
  );
  // A work order holds a room under any live hold state. The create RPC records
  // `out-of-order`, so matching only the literal `blocked` under-reported holds
  // and made Maintenance disagree with Housekeeping.
  const holdsRoom = (o: Row) =>
    o["blocks_room"] === true &&
    ["blocked", "out-of-order", "out-of-service", "under-maintenance"].includes(
      String(o["block_status"] ?? ""),
    );

  // A plan is due when its own next service date says so — a status word that
  // happens to contain "due" is not a schedule.
  const pmHorizon = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const pmDue = scoped.pmScoped.filter((p) => {
    const next = p["next_due_date"] ? String(p["next_due_date"]).slice(0, 10) : "";
    return next !== "" && next <= pmHorizon;
  }).length;
  const oooAssets = scoped.assetsScoped.filter((a) => a["status"] === "out-of-service").length;

  // Rooms come from the property's canonical room inventory, and their lifecycle
  // stage comes from the same canonical room state PMS and Housekeeping read.
  const stageByRoomId = useMemo(() => {
    const map = new Map<string, RoomStage>();
    for (const s of (roomStates.data ?? []) as unknown as CanonicalRoomState[]) {
      if (s.room_id) map.set(String(s.room_id), roomStage(s));
    }
    return map;
  }, [roomStates.data]);

  const roomOptionsRaw = useMemo(
    () =>
      (rooms.data ?? [])
        .filter((r) => !branchId || String((r as Row)["branch_id"]) === branchId)
        .map((r) => {
          const id = String((r as Row)["id"]);
          const stage = stageByRoomId.get(id);
          return {
            id,
            number: String((r as Row)["room_number"] ?? ""),
            stage: stage ? STAGE_LABELS[stage] : null,
          };
        })
        .filter((r) => r.id && r.number),
    [rooms.data, branchId, stageByRoomId],
  );
  // A background refetch must not rebuild the picker under the operator's
  // finger — that is what loses a click that keyboard selection survives.
  const roomOptions = useStableList(roomOptionsRaw);

  // "Rooms blocked" is read from the same canonical room state Housekeeping and
  // PMS read, so the three modules can no longer report different figures. A
  // work order that holds a room without a canonical hold is counted too, so a
  // hold is never silently lost.
  const blockedRooms = useMemo(() => {
    const held = new Set<string>();
    for (const [roomId, stage] of stageByRoomId) {
      if (stage === "out-of-order" || stage === "out-of-service" || stage === "maintenance-fault")
        held.add(roomId);
    }
    for (const o of scoped.ordersScoped) {
      if (holdsRoom(o) && o["room_id"]) held.add(String(o["room_id"]));
    }
    return [...held];
  }, [stageByRoomId, scoped.ordersScoped]);

  const roomLabel = (room_id?: unknown, number?: unknown) =>
    number ? `Room ${String(number)}` : room_id ? "Linked room" : "—";

  return (
    <OpsGuard module="maintenance">
      <PageHeader
        eyebrow="Operations"
        title="Maintenance"
        description="Work orders, room blocking and preventive plans. Only an authorised completion returns a blocked room through inspection."
        actions={
          can("maintenance", "create") || can("maintenance", "edit") ? (
            <>
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogTrigger asChild>
                  <Button>New work order</Button>
                </DialogTrigger>
                <DialogContent className="max-h-[85vh] overflow-y-auto">
                  <DialogHeader>
                    <DialogTitle>New work order</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div>
                      <Label>Description</Label>
                      <Textarea
                        value={newDesc}
                        onChange={(e) => setNewDesc(e.target.value)}
                        placeholder="What is the fault?"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Fault category</Label>
                        {/* The categories are the hotel's own list, not a
                            fixed one: their response and resolution targets
                            are what make a job overdue later. */}
                        <Select
                          value={newCategory}
                          onValueChange={(v) => {
                            setNewCategory(v);
                            const chosen = categoryOptions.find((c) => c.id === v);
                            if (chosen?.defaultPriority) setNewPriority(chosen.defaultPriority);
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a category" />
                          </SelectTrigger>
                          <SelectContent>
                            {categoryOptions.length === 0 ? (
                              <div className="px-2 py-3 text-sm text-muted-foreground">
                                No fault categories configured yet.
                              </div>
                            ) : (
                              categoryOptions.map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.name}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                        {categoryOptions.length === 0 && !categories.isLoading ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            <Link
                              to="/admin/maintenance-categories"
                              className="text-primary hover:underline"
                            >
                              Set up fault categories
                            </Link>{" "}
                            so faults are filed and escalated consistently.
                          </p>
                        ) : null}
                      </div>
                      <div>
                        <Label>Priority</Label>
                        <Select value={newPriority} onValueChange={setNewPriority}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {WO_PRIORITIES.map((p) => (
                              <SelectItem key={p} value={p}>
                                {titleCase(p)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div>
                      <Label>Room (optional)</Label>
                      <Select value={newRoom} onValueChange={setNewRoom}>
                        <SelectTrigger>
                          <SelectValue placeholder="No specific room" />
                        </SelectTrigger>
                        <SelectContent>
                          {roomOptions.length === 0 ? (
                            <div className="px-2 py-3 text-sm text-muted-foreground">
                              No rooms configured for this property yet.
                            </div>
                          ) : (
                            roomOptions.map((opt) => (
                              <SelectItem key={opt.id} value={opt.id}>
                                Room {opt.number}
                                {opt.stage ? ` — ${opt.stage}` : ""}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Asset (optional)</Label>
                      <Select value={newAsset} onValueChange={setNewAsset}>
                        <SelectTrigger>
                          <SelectValue placeholder="No specific asset" />
                        </SelectTrigger>
                        <SelectContent>
                          {scoped.assetsScoped.map((a) => (
                            <SelectItem key={String(a["id"])} value={String(a["id"])}>
                              {String(a["name"])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>Where is it? (optional)</Label>
                      <Input
                        value={newLocation}
                        onChange={(e) => setNewLocation(e.target.value)}
                        placeholder="Kitchen back wall, staff corridor, pool plant room"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Wanted by (optional)</Label>
                        <NeoDatePicker value={newDue} onChange={setNewDue} />
                      </div>
                      <div>
                        <Label>Estimated cost (optional)</Label>
                        <Input
                          type="number"
                          min="0"
                          value={newEstimate}
                          onChange={(e) => setNewEstimate(e.target.value)}
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={newBlocks}
                        onCheckedChange={(v) => setNewBlocks(Boolean(v))}
                      />
                      Remove linked room from availability until work completes
                    </label>
                  </div>
                  <DialogFooter>
                    <Button
                      disabled={!newDesc.trim() || saveWO.isPending}
                      onClick={() =>
                        saveWO.mutate(
                          {
                            description: newDesc,
                            category_id: newCategory || null,
                            priority: newPriority,
                            room_id: newRoom || null,
                            asset_id: newAsset || null,
                            location_label: newLocation.trim() || null,
                            estimated_completion: newDue
                              ? new Date(`${newDue}T17:00:00`).toISOString()
                              : null,
                            cost_estimate: newEstimate.trim() === "" ? null : Number(newEstimate),
                            blocks_room: newBlocks,
                          },
                          {
                            onSuccess: () => {
                              setOpen(false);
                              setNewDesc("");
                              setNewBlocks(false);
                              setNewRoom("");
                              setNewAsset("");
                              setNewLocation("");
                              setNewDue("");
                              setNewEstimate("");
                            },
                          },
                        )
                      }
                    >
                      Create work order
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Dialog open={pmOpen} onOpenChange={setPmOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline">Preventive plan</Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Preventive maintenance plan</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-3">
                    <div>
                      <Label>Name</Label>
                      <Input
                        value={pmName}
                        onChange={(e) => setPmName(e.target.value)}
                        placeholder="e.g. HVAC quarterly service"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Type</Label>
                        <Select value={pmType} onValueChange={setPmType}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="preventive">Preventive</SelectItem>
                            <SelectItem value="predictive">Predictive</SelectItem>
                            <SelectItem value="inspection">Inspection</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Frequency</Label>
                        <Select value={pmFreq} onValueChange={setPmFreq}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PM_FREQUENCIES.map((f) => (
                              <SelectItem key={f.key} value={f.key}>
                                {f.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {/* A plan that names no equipment and no first service date
                        can never fall due, so the recurrence would never run. */}
                    <div>
                      <Label>Equipment (optional)</Label>
                      <Select value={pmAsset} onValueChange={setPmAsset}>
                        <SelectTrigger>
                          <SelectValue placeholder="No specific asset" />
                        </SelectTrigger>
                        <SelectContent>
                          {scoped.assetsScoped.map((a) => (
                            <SelectItem key={String(a["id"])} value={String(a["id"])}>
                              {String(a["name"])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>First service due</Label>
                        <NeoDatePicker value={pmNextDue} onChange={setPmNextDue} />
                      </div>
                      <div>
                        <Label>Usual technician (optional)</Label>
                        <Select value={pmAssignee} onValueChange={setPmAssignee}>
                          <SelectTrigger>
                            <SelectValue placeholder="Decide each time" />
                          </SelectTrigger>
                          <SelectContent>
                            {(technicians.data ?? []).length === 0 ? (
                              <div className="px-3 py-3 text-xs text-muted-foreground">
                                No one at this property can currently receive maintenance work.
                                Give their role the Maintenance “My jobs” permission first.
                              </div>
                            ) : (
                              (technicians.data ?? []).map((s) => (
                                <SelectItem key={String(s.id)} value={String(s.id)}>
                                  {String(s.full_name)}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button
                      disabled={!pmName.trim() || !pmNextDue || savePm.isPending}
                      onClick={() =>
                        savePm.mutate(
                          {
                            name: pmName,
                            maintenance_type: pmType,
                            frequency: pmFreq,
                            interval_days: PM_FREQUENCIES.find((f) => f.key === pmFreq)?.days ?? 30,
                            asset_id: pmAsset || null,
                            next_due_date: pmNextDue,
                            assigned_to: pmAssignee || null,
                            // Must match the status the recurrence generator
                            // looks for, or a saved plan would never fall due.
                            status: "active",
                          },
                          {
                            onSuccess: () => {
                              setPmOpen(false);
                              setPmName("");
                              setPmAsset("");
                              setPmNextDue("");
                              setPmAssignee("");
                            },
                          },
                        )
                      }
                    >
                      Save plan
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          ) : null
        }
      />

      {/* Counters never present "0" as a business fact while the canonical
          reads are still in flight — an unsettled query shows "…" instead. */}
      <div className="neo-kpi-grid mb-6">
        <StatCard
          lead
          label="Open work orders"
          value={orders.isPending ? "…" : String(openOrders.length)}
          hint="not closed or cancelled"
        />
        <StatCard
          label="Rooms blocked"
          value={roomStates.isPending ? "…" : String(blockedRooms.length)}
          hint="maintenance hold on the canonical room state"
        />
        <StatCard
          label="PM plans falling due"
          value={pmPlans.isPending ? "…" : String(pmDue)}
          hint="plans with a service date inside 14 days — dashboards count outstanding occurrences"
        />
        <StatCard
          label="Assets out of service"
          value={assets.isPending ? "…" : String(oooAssets)}
          hint="in the selected property"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["orders", "pm", "assets"] as const).map((t) => (
          <Button
            key={t}
            size="sm"
            variant={tab === t ? "default" : "outline"}
            onClick={() => setTab(t)}
          >
            {t === "orders" ? "Work orders" : t === "pm" ? "Preventive plans" : "Assets"}
          </Button>
        ))}
        {tab === "orders" ? (
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/admin/maintenance-categories">Fault categories</Link>
            </Button>
            {can("maintenance", "edit") ? (
              // Overdue work raises the existing escalation and notification
              // records — the targets come from the category, not from here.
              <Button
                size="sm"
                variant="outline"
                onClick={() => escalate.mutate()}
                disabled={escalate.isPending}
              >
                Check overdue work
              </Button>
            ) : null}
          </div>
        ) : null}
        {tab === "pm" && can("maintenance", "edit") ? (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => generatePm.mutate(14)}
            disabled={generatePm.isPending}
          >
            Generate due within 14 days
          </Button>
        ) : null}
      </div>

      {tab === "orders" && (
        <SectionCard
          title="Work orders"
          description="Advance the status; blocking a room removes it from availability until an authorised release."
        >
          <QueryState
            isLoading={orders.isLoading}
            error={orders.error}
            isEmpty={scoped.ordersScoped.length === 0}
            empty={
              <EmptyState
                title="No work orders"
                description="Faults raised from the property appear here with their full status trail."
                icon={Wrench}
              />
            }
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Work order</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Block</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scoped.ordersScoped.map((o) => (
                    <TableRow key={String(o["id"])}>
                      <TableCell className="font-medium">
                        {String(o["work_order_number"] ?? "—")}
                        <div
                          className="max-w-[260px] truncate text-xs font-normal text-muted-foreground"
                          title={String(o["description"] ?? "")}
                        >
                          {String(o["description"] ?? "")}
                        </div>
                      </TableCell>
                      <TableCell>
                        {roomLabel(o["room_id"], o["rooms"]?.room_number) ||
                          String(o["location_label"] ?? "—")}
                      </TableCell>
                      <TableCell>
                        {o["category_id"]
                          ? (categoryNameById.get(String(o["category_id"])) ??
                            titleCase(o["fault_category"]))
                          : titleCase(o["fault_category"])}
                      </TableCell>
                      <TableCell>
                        <OpsBadge
                          value={o["priority"]}
                          tone={
                            String(o["priority"]) === "urgent" ||
                            String(o["priority"]) === "emergency"
                              ? "destructive"
                              : String(o["priority"]) === "high"
                                ? "warning"
                                : "info"
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <OpsBadge value={o["status"]} tone={woStatusTone(o["status"])} />
                      </TableCell>
                      <TableCell>
                        {o["room_id"] ? (
                          holdsRoom(o) ? (
                            <OpsBadge value="Blocked" tone="destructive" />
                          ) : (
                            <OpsBadge value="Available" tone="success" />
                          )
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-2">
                          <Select
                            value={String(o["status"])}
                            onValueChange={(v) =>
                              v !== String(o["status"]) &&
                              saveWO.mutate({ id: String(o["id"]), status: v })
                            }
                          >
                            <SelectTrigger className="h-9 w-40">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {WO_STATUSES.map((s) => (
                                <SelectItem key={s} value={s}>
                                  {titleCase(s)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {/* A finished job is not a closed job: a supervisor
                              other than the person who did the work has to
                              check it, and that check is stamped on the record. */}
                          {String(o["status"]) === "completed" ? (
                            <Button
                              size="sm"
                              onClick={() =>
                                saveWO.mutate({
                                  id: String(o["id"]),
                                  status: "awaiting-verification",
                                })
                              }
                              disabled={saveWO.isPending}
                            >
                              Send for checking
                            </Button>
                          ) : null}
                          {String(o["status"]) === "awaiting-verification" ? (
                            <Button
                              size="sm"
                              onClick={() =>
                                saveWO.mutate({ id: String(o["id"]), status: "closed" })
                              }
                              disabled={saveWO.isPending}
                            >
                              Verify &amp; close
                            </Button>
                          ) : null}
                          {o["room_id"] ? (
                            holdsRoom(o) ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  setBlock.mutate({ workOrder: String(o["id"]), block: false })
                                }
                                disabled={setBlock.isPending}
                              >
                                Release room
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  setBlock.mutate({ workOrder: String(o["id"]), block: true })
                                }
                                disabled={setBlock.isPending}
                              >
                                Block room
                              </Button>
                            )
                          ) : null}
                          {can("maintenance", "work-orders.assign") ||
                          can("maintenance", "edit") ? (
                            <div className="flex flex-col gap-1">
                              <Select
                                value={
                                  o["assigned_to"] && eligibleIds.has(String(o["assigned_to"]))
                                    ? String(o["assigned_to"])
                                    : ""
                                }
                                onValueChange={(v) =>
                                  v &&
                                  saveWO.mutate({
                                    id: String(o["id"]),
                                    assigned_to: v,
                                    status: "assigned",
                                  })
                                }
                              >
                                <SelectTrigger className="h-9 w-44">
                                  <SelectValue placeholder="Assign" />
                                </SelectTrigger>
                                <SelectContent>
                                  {(technicians.data ?? []).length === 0 ? (
                                    <div className="px-3 py-3 text-xs text-muted-foreground">
                                      No one at this property can currently receive maintenance
                                      work. Give their role the Maintenance “My jobs” permission
                                      first.
                                    </div>
                                  ) : (
                                    (technicians.data ?? []).map((s) => (
                                      <SelectItem key={String(s.id)} value={String(s.id)}>
                                        {String(s.full_name)}
                                      </SelectItem>
                                    ))
                                  )}
                                </SelectContent>
                              </Select>
                              {o["assigned_to"] &&
                              technicians.data &&
                              !eligibleIds.has(String(o["assigned_to"])) ? (
                                <span className="text-[11px] text-warning">
                                  Current holder can no longer work maintenance jobs — reassign, or
                                  give their role the Maintenance “My jobs” permission.
                                </span>
                              ) : null}
                            </div>
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
      )}

      {tab === "pm" && (
        <SectionCard
          title="Preventive maintenance plans"
          description="Plans fall due on their cycle; generating creates work orders without duplicates."
        >
          <QueryState
            isLoading={pmPlans.isLoading}
            error={pmPlans.error}
            isEmpty={scoped.pmScoped.length === 0}
            empty={
              <EmptyState
                title="No preventive plans"
                description="Add a plan to schedule recurring service work."
                icon={Wrench}
              />
            }
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plan</TableHead>
                    <TableHead>Equipment</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Next due</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scoped.pmScoped.map((p) => (
                    <TableRow key={String(p["id"])}>
                      <TableCell className="font-medium">{String(p["name"])}</TableCell>
                      <TableCell>
                        {maintStr((p["assets"] as Row | null)?.["name"], "Not linked")}
                      </TableCell>
                      <TableCell>{titleCase(p["maintenance_type"])}</TableCell>
                      <TableCell>{titleCase(p["frequency"])}</TableCell>
                      <TableCell>{shortDateTime(p["next_due_date"])}</TableCell>
                      <TableCell>
                        <OpsBadge
                          value={p["status"]}
                          tone={
                            String(p["status"]).toLowerCase().includes("due")
                              ? "warning"
                              : "success"
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          </QueryState>
        </SectionCard>
      )}

      {tab === "assets" && (
        <SectionCard
          title="Asset register"
          description="Equipment condition and service status for the selected property."
        >
          <QueryState
            isLoading={assets.isLoading}
            error={assets.error}
            isEmpty={scoped.assetsScoped.length === 0}
            empty={
              <EmptyState
                title="No assets registered"
                description="Equipment added here supports preventive work and warranty tracking."
                icon={Wrench}
              />
            }
          >
            <TableScroll>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset</TableHead>
                    <TableHead>Tag</TableHead>
                    <TableHead>Condition</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Next service</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {scoped.assetsScoped.map((a) => (
                    <TableRow key={String(a["id"])}>
                      <TableCell className="font-medium">{String(a["name"])}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {String(a["asset_tag"] ?? "—")}
                      </TableCell>
                      <TableCell>
                        <OpsBadge
                          value={a["condition"]}
                          tone={
                            String(a["condition"]) === "poor" ||
                            String(a["condition"]) === "unserviceable"
                              ? "destructive"
                              : String(a["condition"]) === "fair"
                                ? "warning"
                                : "success"
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <OpsBadge
                          value={a["status"]}
                          tone={
                            String(a["status"]) === "out-of-service"
                              ? "destructive"
                              : String(a["status"]) === "under-maintenance"
                                ? "warning"
                                : "info"
                          }
                        />
                      </TableCell>
                      <TableCell>{shortDateTime(a["next_service_date"])}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableScroll>
          </QueryState>
        </SectionCard>
      )}
    </OpsGuard>
  );
}
