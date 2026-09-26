import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, Users } from "lucide-react";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
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
import { NeoDatePicker } from "@/components/common/DatePicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
import { EmptyState, PmsGuard, QueryState } from "@/components/pms/PmsShared";
import { formatDateTime, money, nightsBetween, titleCase } from "@/lib/pms";
import { useGroupBookings, useRoomTypes } from "@/lib/pms-data";
import { useAuth } from "@/lib/auth";
import {
  useAddRoomingRow,
  useCreateGroupBooking,
  useConvertRoomingRow,
  useGroupBlocks,
  useGroupBooking,
  useGroupEvents,
  useRecordGroupDeposit,
  useReleaseBlock,
  useRoomingList,
  useSaveGroupBlock,
} from "@/lib/frontdesk-ops";

export const Route = createFileRoute("/_shell/pms/groups")({
  head: () => ({
    meta: [
      { title: "Groups & Room Blocks — NEØ" },
      {
        name: "description",
        content:
          "Group bookings, allocated room blocks, rooming lists, deposits and cut-off release.",
      },
      { property: "og:title", content: "Groups & Room Blocks — NEØ" },
      {
        property: "og:description",
        content:
          "Group bookings, allocated room blocks, rooming lists, deposits and cut-off release.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <PmsGuard action="groups.view">
      <GroupsPage />
    </PmsGuard>
  ),
});

function GroupsPage() {
  const { can } = useAuth();
  const groups = useGroupBookings();
  const createGroup = useCreateGroupBooking();
  const rows = groups.data ?? [];
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [groupForm, setGroupForm] = useState({ name: "", organizer: "", groupType: "conference", arrival: "", departure: "", rooms: "1", guests: "1", cutoff: "", deposit: "0", billing: "" });
  const mayCreate = can("front-office", "groups", "create") || can("pms", "write");

  return (
    <div>
      <PageHeader
        eyebrow="Front Office"
        title="Groups & Room Blocks"
        description="Conference, tour and corporate groups: the rooms held for them, the rooming list, deposits and the date unused rooms release back to sale."
        actions={mayCreate ? <Button onClick={() => setCreating(true)}><Plus className="mr-2 size-4" /> New group</Button> : null}
      />

      <SectionCard
        title={`${rows.length} group booking(s)`}
        description="Most recent arrivals first. Blocked rooms are withheld from ordinary availability until release."
      >
        <QueryState
          isLoading={groups.isLoading}
          error={groups.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={Users}
              title="No group bookings"
              description="Create a group booking to hold a block of rooms, share one billing instruction and manage a rooming list."
            />
          }
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Group</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Dates</TableHead>
                  <TableHead>Nights</TableHead>
                  <TableHead>Rooms</TableHead>
                  <TableHead>Deposit</TableHead>
                  <TableHead>Cut-off</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Manage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium">{g.reference}</TableCell>
                    <TableCell>
                      <div>{g.name}</div>
                      <p className="text-xs text-muted-foreground">{titleCase(g.group_type)}</p>
                    </TableCell>
                    <TableCell>{g.corporate_accounts?.legal_name ?? g.organizer ?? "—"}</TableCell>
                    <TableCell>
                      {g.arrival_date} → {g.departure_date}
                    </TableCell>
                    <TableCell>{nightsBetween(g.arrival_date, g.departure_date)}</TableCell>
                    <TableCell>{g.rooms_count ?? 0}</TableCell>
                    <TableCell>
                      {money(g.deposit_paid ?? 0)}
                      <span className="text-xs text-muted-foreground">
                        {" "}
                        / {money(g.deposit_required ?? 0)}
                      </span>
                    </TableCell>
                    <TableCell>{g.cutoff_date ?? "—"}</TableCell>
                    <TableCell>
                      <StatusPill
                        tone={
                          g.status === "cancelled"
                            ? "destructive"
                            : g.status === "confirmed"
                              ? "success"
                              : "info"
                        }
                      >
                        {titleCase(g.status)}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => setOpenId(g.id)}>
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader><DialogTitle>New group booking</DialogTitle><DialogDescription>Create the group first, then open it to add room blocks, rooming list and deposits.</DialogDescription></DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Label>Group name</Label><Input value={groupForm.name} onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })} /></div>
            <div><Label>Organizer</Label><Input value={groupForm.organizer} onChange={(e) => setGroupForm({ ...groupForm, organizer: e.target.value })} /></div>
            <div><Label>Type</Label><Select value={groupForm.groupType} onValueChange={(v) => setGroupForm({ ...groupForm, groupType: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="conference">Conference</SelectItem><SelectItem value="tour">Tour</SelectItem><SelectItem value="corporate">Corporate</SelectItem><SelectItem value="wedding">Wedding</SelectItem><SelectItem value="group">Other group</SelectItem></SelectContent></Select></div>
            <div><Label>Arrival</Label><Input type="date" value={groupForm.arrival} onChange={(e) => setGroupForm({ ...groupForm, arrival: e.target.value })} /></div>
            <div><Label>Departure</Label><Input type="date" value={groupForm.departure} onChange={(e) => setGroupForm({ ...groupForm, departure: e.target.value })} /></div>
            <div><Label>Rooms</Label><Input type="number" min={0} value={groupForm.rooms} onChange={(e) => setGroupForm({ ...groupForm, rooms: e.target.value })} /></div>
            <div><Label>Guests</Label><Input type="number" min={0} value={groupForm.guests} onChange={(e) => setGroupForm({ ...groupForm, guests: e.target.value })} /></div>
            <div><Label>Cut-off</Label><Input type="date" value={groupForm.cutoff} onChange={(e) => setGroupForm({ ...groupForm, cutoff: e.target.value })} /></div>
            <div><Label>Deposit required</Label><Input type="number" min={0} value={groupForm.deposit} onChange={(e) => setGroupForm({ ...groupForm, deposit: e.target.value })} /></div>
            <div className="sm:col-span-2"><Label>Billing instructions</Label><Textarea value={groupForm.billing} onChange={(e) => setGroupForm({ ...groupForm, billing: e.target.value })} /></div>
          </div>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setCreating(false)}>Cancel</Button><Button disabled={createGroup.isPending || !groupForm.name.trim() || !groupForm.arrival || !groupForm.departure} onClick={() => createGroup.mutate({ name: groupForm.name, ...(groupForm.organizer ? { organizer: groupForm.organizer } : {}), groupType: groupForm.groupType, arrival: groupForm.arrival, departure: groupForm.departure, rooms: Number(groupForm.rooms) || 0, guests: Number(groupForm.guests) || 0, cutoff: groupForm.cutoff || null, depositRequired: Number(groupForm.deposit) || 0, ...(groupForm.billing ? { billingInstructions: groupForm.billing } : {}), status: "tentative" }, { onSuccess: (r) => { setCreating(false); setOpenId(r.id); } })}>Create group</Button></div>
        </DialogContent>
      </Dialog>

      <GroupDialog groupId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function GroupDialog({ groupId, onClose }: { groupId: string | null; onClose: () => void }) {
  const group = useGroupBooking(groupId ?? "");
  return (
    <Dialog open={Boolean(groupId)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{group.data?.name ?? "Group"}</DialogTitle>
          <DialogDescription>
            {group.data
              ? `${group.data.reference} · ${group.data.arrival_date} → ${group.data.departure_date}`
              : "Loading group…"}
          </DialogDescription>
        </DialogHeader>
        {groupId ? (
          <Tabs defaultValue="blocks">
            <TabsList>
              <TabsTrigger value="blocks">Room blocks</TabsTrigger>
              <TabsTrigger value="rooming">Rooming list</TabsTrigger>
              <TabsTrigger value="deposit">Deposit &amp; billing</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="blocks" className="pt-4">
              <BlocksTab groupId={groupId} />
            </TabsContent>
            <TabsContent value="rooming" className="pt-4">
              <RoomingTab groupId={groupId} />
            </TabsContent>
            <TabsContent value="deposit" className="pt-4">
              <DepositTab groupId={groupId} />
            </TabsContent>
            <TabsContent value="history" className="pt-4">
              <HistoryTab groupId={groupId} />
            </TabsContent>
          </Tabs>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function BlocksTab({ groupId }: { groupId: string }) {
  const blocks = useGroupBlocks(groupId);
  const roomTypes = useRoomTypes();
  const save = useSaveGroupBlock();
  const release = useReleaseBlock();
  const [form, setForm] = useState({
    roomTypeId: "",
    rooms: "5",
    comp: "0",
    rate: "0",
    start: "",
    end: "",
    cutoff: "",
  });
  const [reason, setReason] = useState("");

  return (
    <div className="space-y-6">
      <QueryState
        isLoading={blocks.isLoading}
        error={blocks.error}
        isEmpty={(blocks.data ?? []).length === 0}
        empty={
          <EmptyState
            title="No rooms blocked yet"
            description="Add a block per room type so those rooms stop appearing as ordinarily available."
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Room type</TableHead>
              <TableHead>Dates</TableHead>
              <TableHead>Blocked</TableHead>
              <TableHead>Picked up</TableHead>
              <TableHead>Comp</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead>Cut-off</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Release</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(blocks.data ?? []).map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-medium">{b.room_types?.name ?? "—"}</TableCell>
                <TableCell>
                  {b.start_date} → {b.end_date}
                </TableCell>
                <TableCell>{b.rooms_blocked ?? 0}</TableCell>
                <TableCell>{b.rooms_picked_up ?? 0}</TableCell>
                <TableCell>{b.complimentary_rooms ?? 0}</TableCell>
                <TableCell>{money(b.rate_amount ?? 0)}</TableCell>
                <TableCell>{b.cutoff_date ?? "—"}</TableCell>
                <TableCell>
                  <StatusPill tone={b.status === "released" ? "warning" : "success"}>
                    {titleCase(b.status)}
                  </StatusPill>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      b.status === "released" || release.isPending || reason.trim().length < 3
                    }
                    onClick={() => release.mutate({ block: b.id, reason })}
                  >
                    Release unused
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </QueryState>

      <div className="grid gap-1.5">
        <Label htmlFor="release-reason">Release reason (required before releasing a block)</Label>
        <Input
          id="release-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Cut-off reached, unsold rooms returned to sale"
        />
      </div>

      <SectionCard
        title="Add a room block"
        description="Blocked rooms are excluded from general availability until the cut-off releases them."
      >
        <div className="grid gap-3 md:grid-cols-4">
          <div className="grid gap-1.5 md:col-span-2">
            <Label>Room type</Label>
            <Select
              value={form.roomTypeId}
              onValueChange={(v) => setForm({ ...form, roomTypeId: v })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select room type" />
              </SelectTrigger>
              <SelectContent>
                {(roomTypes.data ?? []).map((rt) => (
                  <SelectItem key={rt.id} value={rt.id}>
                    {rt.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Field
            label="Rooms"
            value={form.rooms}
            onChange={(v) => setForm({ ...form, rooms: v })}
          />
          <Field
            label="Complimentary"
            value={form.comp}
            onChange={(v) => setForm({ ...form, comp: v })}
          />
          <Field
            label="Nightly rate"
            value={form.rate}
            onChange={(v) => setForm({ ...form, rate: v })}
          />
          <Field
            label="From"
            type="date"
            value={form.start}
            onChange={(v) => setForm({ ...form, start: v })}
          />
          <Field
            label="To"
            type="date"
            value={form.end}
            onChange={(v) => setForm({ ...form, end: v })}
          />
          <Field
            label="Cut-off"
            type="date"
            value={form.cutoff}
            onChange={(v) => setForm({ ...form, cutoff: v })}
          />
        </div>
        <Button
          className="mt-4"
          disabled={!form.roomTypeId || !form.start || !form.end || save.isPending}
          onClick={() =>
            save.mutate({
              groupId,
              roomTypeId: form.roomTypeId,
              roomsBlocked: Number(form.rooms || 0),
              complimentaryRooms: Number(form.comp || 0),
              rateAmount: Number(form.rate || 0),
              startDate: form.start,
              endDate: form.end,
              cutoffDate: form.cutoff || null,
              ratePlanId: null,
              mealPlanId: null,
            })
          }
        >
          Save block
        </Button>
      </SectionCard>
    </div>
  );
}

function RoomingTab({ groupId }: { groupId: string }) {
  const rooming = useRoomingList(groupId);
  const roomTypes = useRoomTypes();
  const blocks = useGroupBlocks(groupId);
  const add = useAddRoomingRow();
  const convert = useConvertRoomingRow();
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    arrival: "",
    departure: "",
    adults: "1",
    children: "0",
    blockId: "",
    sharing: "",
    billing: "",
    comp: false,
    requests: "",
  });

  const block = (blocks.data ?? []).find((b) => b.id === form.blockId);
  const blockName = (id: string | null) =>
    (blocks.data ?? []).find((b) => b.id === id)?.room_types?.name ?? "—";

  return (
    <div className="space-y-6">
      <QueryState
        isLoading={rooming.isLoading}
        error={rooming.error}
        isEmpty={(rooming.data ?? []).length === 0}
        empty={
          <EmptyState
            title="No named guests yet"
            description="Add guests to the rooming list, then convert each one into a reservation drawn from the block."
          />
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Guest</TableHead>
              <TableHead>Dates</TableHead>
              <TableHead>Room type</TableHead>
              <TableHead>Sharing</TableHead>
              <TableHead>Billing</TableHead>
              <TableHead>Reservation</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rooming.data ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">
                  {r.guest_name}
                  {r.complimentary ? (
                    <span className="ml-2 text-xs text-muted-foreground">complimentary</span>
                  ) : null}
                </TableCell>
                <TableCell>
                  {r.arrival_date} → {r.departure_date}
                </TableCell>
                <TableCell>{blockName(r.block_id)}</TableCell>
                <TableCell>{r.sharing_with ?? "—"}</TableCell>
                <TableCell>{r.billing_instruction ?? "Master folio"}</TableCell>
                <TableCell>{r.reservation_id ? "Created" : "—"}</TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={Boolean(r.reservation_id) || convert.isPending}
                    onClick={() => convert.mutate({ row: r.id })}
                  >
                    {r.reservation_id ? "Converted" : "Create reservation"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </QueryState>

      <SectionCard
        title="Add a guest"
        description="Each conversion draws one room from the selected block."
      >
        <div className="grid gap-3 md:grid-cols-4">
          <Field
            label="Guest name"
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
          />
          <Field
            label="Email"
            value={form.email}
            onChange={(v) => setForm({ ...form, email: v })}
          />
          <Field
            label="Phone"
            value={form.phone}
            onChange={(v) => setForm({ ...form, phone: v })}
          />
          <div className="grid gap-1.5">
            <Label>Block</Label>
            <Select value={form.blockId} onValueChange={(v) => setForm({ ...form, blockId: v })}>
              <SelectTrigger>
                <SelectValue placeholder="Select block" />
              </SelectTrigger>
              <SelectContent>
                {(blocks.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.room_types?.name ?? "Block"} ·{" "}
                    {(b.rooms_blocked ?? 0) - (b.rooms_picked_up ?? 0)} left
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Field
            label="Arrival"
            type="date"
            value={form.arrival}
            onChange={(v) => setForm({ ...form, arrival: v })}
          />
          <Field
            label="Departure"
            type="date"
            value={form.departure}
            onChange={(v) => setForm({ ...form, departure: v })}
          />
          <Field
            label="Adults"
            value={form.adults}
            onChange={(v) => setForm({ ...form, adults: v })}
          />
          <Field
            label="Children"
            value={form.children}
            onChange={(v) => setForm({ ...form, children: v })}
          />
          <Field
            label="Sharing with"
            value={form.sharing}
            onChange={(v) => setForm({ ...form, sharing: v })}
          />
          <Field
            label="Billing instruction"
            value={form.billing}
            onChange={(v) => setForm({ ...form, billing: v })}
          />
          <div className="flex items-center gap-2 pt-6">
            <Switch
              id="comp"
              checked={form.comp}
              onCheckedChange={(v) => setForm({ ...form, comp: v })}
            />
            <Label htmlFor="comp">Complimentary room</Label>
          </div>
        </div>
        <div className="mt-3 grid gap-1.5">
          <Label htmlFor="rooming-requests">Special requests</Label>
          <Textarea
            id="rooming-requests"
            value={form.requests}
            onChange={(e) => setForm({ ...form, requests: e.target.value })}
          />
        </div>
        <Button
          className="mt-4"
          disabled={!form.name || !form.arrival || !form.departure || add.isPending}
          onClick={() =>
            add.mutate({
              groupId,
              blockId: form.blockId || null,
              roomTypeId: block?.room_type_id ?? null,
              guestName: form.name,
              email: form.email,
              phone: form.phone,
              arrival: form.arrival,
              departure: form.departure,
              adults: Number(form.adults || 1),
              children: Number(form.children || 0),
              sharingWith: form.sharing,
              billingInstruction: form.billing,
              complimentary: form.comp,
              specialRequests: form.requests,
            })
          }
        >
          Add to rooming list
        </Button>
      </SectionCard>
    </div>
  );
}

function DepositTab({ groupId }: { groupId: string }) {
  const group = useGroupBooking(groupId);
  const deposit = useRecordGroupDeposit();
  const [form, setForm] = useState({ amount: "", method: "bank-transfer", reference: "" });
  const g = group.data;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Metric label="Deposit required" value={money(g?.deposit_required ?? 0)} />
        <Metric label="Deposit paid" value={money(g?.deposit_paid ?? 0)} />
        <Metric label="Due date" value={g?.deposit_due_date ?? "Not set"} />
      </div>

      <SectionCard
        title="Record a deposit"
        description="Posts to the group master folio. A repeated reference will not post twice."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field
            label="Amount"
            value={form.amount}
            onChange={(v) => setForm({ ...form, amount: v })}
          />
          <div className="grid gap-1.5">
            <Label>Method</Label>
            <Select value={form.method} onValueChange={(v) => setForm({ ...form, method: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["cash", "card", "bank-transfer", "mobile-money", "cheque"].map((m) => (
                  <SelectItem key={m} value={m}>
                    {titleCase(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Field
            label="Reference"
            value={form.reference}
            onChange={(v) => setForm({ ...form, reference: v })}
          />
        </div>
        <Button
          className="mt-4"
          disabled={!form.amount || Number(form.amount) <= 0 || deposit.isPending}
          onClick={() =>
            deposit.mutate({
              group: groupId,
              amount: Number(form.amount),
              method: form.method,
              reference: form.reference,
            })
          }
        >
          Post deposit
        </Button>
      </SectionCard>

      <SectionCard
        title="Billing and cancellation terms"
        description="Recorded on the group and inherited by every rooming-list reservation."
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Billing instructions</dt>
            <dd>{g?.billing_instructions ?? "Not configured"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Cancellation terms</dt>
            <dd>{g?.cancellation_terms ?? "Not configured"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Release policy</dt>
            <dd>{g?.release_policy ?? "Not configured"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Complimentary rooms</dt>
            <dd>{g?.complimentary_rooms ?? 0}</dd>
          </div>
        </dl>
      </SectionCard>
    </div>
  );
}

function HistoryTab({ groupId }: { groupId: string }) {
  const events = useGroupEvents(groupId);
  return (
    <QueryState
      isLoading={events.isLoading}
      error={events.error}
      isEmpty={(events.data ?? []).length === 0}
      empty={
        <EmptyState
          title="No block activity yet"
          description="Pickups, releases and deposits appear here with the actor and timestamp."
        />
      }
    >
      <ul className="space-y-3">
        {(events.data ?? []).map((e) => (
          <li key={e.id} className="rounded-lg border border-border/60 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{titleCase(e.event_type)}</span>
              <span className="text-xs text-muted-foreground">{formatDateTime(e.created_at)}</span>
            </div>
            <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
              {JSON.stringify(e.new_value, null, 2)}
            </pre>
          </li>
        ))}
      </ul>
    </QueryState>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  const id = `f-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {type === "date" ? (
        <NeoDatePicker id={id} value={value} onChange={onChange} />
      ) : (
        <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}
